//! Synthetic-only pipe probe. An independently launched browser host does not
//! have this inherited bootstrap and must not infer its authority from a PID.

use aerift_transfer::ambient_browser::{BrowserPickup, ExtensionOrigin, MAX_MESSAGE_BYTES};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    process::{Command, Stdio},
    ptr::null_mut,
    time::Instant,
};
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::{
        ERROR_INSUFFICIENT_BUFFER, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
    },
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_GROUPS, TOKEN_QUERY, TokenLogonSid,
    },
    Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_WRITE_DATA,
        PIPE_ACCESS_DUPLEX, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT, SYNCHRONIZE,
    },
    System::{
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
            GetNamedPipeServerProcessId, PIPE_REJECT_REMOTE_CLIENTS,
        },
        Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

const ORIGIN: &str = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
const HTTP_FREE_FIXTURE: &str =
    r#"{"version":1,"kind":"selection","value":"synthetic offline fixture"}"#;
const PIPE_ACCESS: u32 = FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE;

fn check(ok: bool) -> io::Result<()> {
    if ok {
        Ok(())
    } else {
        Err(io::Error::other("qualification assertion"))
    }
}

struct Alloc(*mut std::ffi::c_void);
impl Drop for Alloc {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn logon_sid() -> io::Result<String> {
    let mut token: HANDLE = null_mut();
    check(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } != 0)?;
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut bytes = 0u32;
    let outcome = unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenLogonSid,
            null_mut(),
            0,
            &mut bytes,
        )
    };
    check(
        outcome == 0
            && io::Error::last_os_error().raw_os_error() == Some(ERROR_INSUFFICIENT_BUFFER as i32),
    )?;
    // Native TOKEN_GROUPS contains pointers. Use an aligned, bounded buffer.
    check((size_of::<TOKEN_GROUPS>() as u32..=8192).contains(&bytes))?;
    let mut data = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
    check(
        unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenLogonSid,
                data.as_mut_ptr().cast(),
                bytes,
                &mut bytes,
            )
        } != 0,
    )?;
    let group = unsafe { &*data.as_ptr().cast::<TOKEN_GROUPS>() };
    check(group.GroupCount == 1)?;
    let mut sid = null_mut();
    check(unsafe { ConvertSidToStringSidW(group.Groups[0].Sid, &mut sid) } != 0)?;
    let _free = Alloc(sid.cast());
    let length = (0..184)
        .find(|&i| unsafe { *sid.add(i) == 0 })
        .ok_or(io::Error::other("sid too long"))?;
    String::from_utf16(unsafe { std::slice::from_raw_parts(sid, length) }).map_err(io::Error::other)
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

fn pipe_name(id: Uuid) -> String {
    format!(r"\\.\pipe\aerift-ambient-qualification-{id}")
}

fn server(name: &str) -> io::Result<File> {
    // Do not grant generic write/FILE_CREATE_PIPE_INSTANCE. Only this logon
    // session can connect; a second per-process check is still mandatory.
    let sddl = wide(&format!("D:P(A;;0x{PIPE_ACCESS:x};;;{})", logon_sid()?));
    let mut sd = null_mut();
    check(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                null_mut(),
            )
        } != 0,
    )?;
    let _free = Alloc(sd);
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd,
        bInheritHandle: 0,
    };
    let raw = unsafe {
        CreateNamedPipeW(
            wide(name).as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_REJECT_REMOTE_CLIENTS,
            1,
            8192,
            (MAX_MESSAGE_BYTES + 20) as u32,
            0,
            &attributes,
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_handle(raw) })
}

fn client(name: &str) -> io::Result<File> {
    OpenOptions::new()
        .access_mode(PIPE_ACCESS)
        .security_qos_flags(SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION)
        .open(name)
}

fn connected(pipe: &File) -> io::Result<()> {
    if unsafe { ConnectNamedPipe(pipe.as_raw_handle(), null_mut()) } != 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32) {
        Ok(())
    } else {
        Err(error)
    }
}

fn client_pid(pipe: &File) -> io::Result<u32> {
    let mut pid = 0;
    check(unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid) } != 0 && pid != 0)?;
    Ok(pid)
}

fn verify_client(pipe: &File, expected: u32) -> io::Result<()> {
    check(client_pid(pipe)? == expected)
}

fn server_pid(pipe: &File) -> io::Result<u32> {
    let mut pid = 0;
    check(unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) } != 0 && pid != 0)?;
    Ok(pid)
}

fn child() -> io::Result<()> {
    let mut bootstrap = [0u8; 20];
    io::stdin().lock().read_exact(&mut bootstrap)?;
    let id = Uuid::from_bytes(bootstrap[..16].try_into().unwrap());
    let expected_server = u32::from_ne_bytes(bootstrap[16..].try_into().unwrap());
    let mut pipe = client(&pipe_name(id))?;
    check(server_pid(&pipe)? == expected_server)?;
    // No pipe name, ticket or payload on command line, stdout or stderr.
    io::stdout().write_all(&[1])?;
    io::stdout().flush()?;
    let mut ticket = [0u8; 16];
    pipe.read_exact(&mut ticket)?;
    pipe.write_all(&ticket)?;
    pipe.write_all(&(HTTP_FREE_FIXTURE.len() as u32).to_ne_bytes())?;
    pipe.write_all(HTTP_FREE_FIXTURE.as_bytes())?;
    let mut result = [0u8; 1];
    pipe.read_exact(&mut result)?;
    check(result == [1])
}

fn fixture() -> io::Result<()> {
    let id = Uuid::new_v4();
    let name = pipe_name(id);
    let mut pipe = server(&name)?;
    // Even an authorized-logon peer is refused without the pinned spawned PID.
    let unrelated = client(&name)?;
    connected(&pipe)?;
    check(client_pid(&pipe)? == std::process::id())?;
    check(verify_client(&pipe, u32::MAX).is_err())?;
    check(unsafe { DisconnectNamedPipe(pipe.as_raw_handle()) } != 0)?;
    drop(unrelated);

    let mut child = Command::new(std::env::current_exe()?)
        .arg("--qualification-child")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let result = (|| {
        let mut bootstrap = child.stdin.take().ok_or(io::Error::other("no bootstrap"))?;
        bootstrap.write_all(id.as_bytes())?;
        bootstrap.write_all(&std::process::id().to_ne_bytes())?;
        drop(bootstrap);
        let mut ready = [0];
        child
            .stdout
            .take()
            .ok_or(io::Error::other("no control"))?
            .read_exact(&mut ready)?;
        check(ready == [1])?;
        connected(&pipe)?;
        verify_client(&pipe, child.id())?;

        let mut pickup = BrowserPickup::default();
        let first = Instant::now();
        let ticket = pickup.arm(first);
        pipe.write_all(ticket.as_bytes())?;
        let mut wire_ticket = [0; 16];
        pipe.read_exact(&mut wire_ticket)?;
        let mut length = [0; 4];
        pipe.read_exact(&mut length)?;
        let size = u32::from_ne_bytes(length) as usize;
        check((1..=MAX_MESSAGE_BYTES).contains(&size))?;
        let mut frame = vec![0; size + 4];
        frame[..4].copy_from_slice(&length);
        pipe.read_exact(&mut frame[4..])?;
        let origin = ExtensionOrigin::authorize(ORIGIN, ORIGIN)
            .map_err(|_| io::Error::other("pickup gate refused"))?;
        let review = pickup
            .submit(
                Uuid::from_bytes(wire_ticket),
                Instant::now(),
                &frame,
                &origin,
            )
            .map_err(|_| io::Error::other("pickup gate refused"))?;
        check(review.literal == "synthetic offline fixture")?;
        check(pickup.confirm(Uuid::nil(), Instant::now()).is_err())?;
        let captured = pickup
            .confirm(review.id, Instant::now())
            .map_err(|_| io::Error::other("pickup gate refused"))?;
        check(captured.entries().len() == 1)?;
        check(pickup.confirm(review.id, Instant::now()).is_err())?;
        pipe.write_all(&[1])?;
        check(child.wait()?.success())
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result?;
    println!(
        "Windows named pipe: spawned endpoint IDs matched, one review enforced; no browser or app opened"
    );
    Ok(())
}

pub(crate) fn run() -> io::Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some("--qualification-child") => child(),
        None => fixture(),
        _ => Err(io::Error::other("unknown qualification role")),
    }
}
