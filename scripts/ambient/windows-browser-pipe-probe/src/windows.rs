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
            ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId,
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

/// Only fixed stage names, the OS code and standard error kind are logged.
/// Never format the underlying error, path, pipe name, SID or proposal.
trait At<T> {
    fn at(self, stage: &'static str) -> io::Result<T>;
}
impl<T> At<T> for io::Result<T> {
    fn at(self, stage: &'static str) -> io::Result<T> {
        self.map_err(|error| {
            if let Some(code) = error.raw_os_error() {
                io::Error::other(format!("{stage}: OS error {code}"))
            } else if error.kind() == io::ErrorKind::Other {
                io::Error::other(format!("{stage}: policy/fixture refused"))
            } else {
                io::Error::other(format!("{stage}: {:?}", error.kind()))
            }
        })
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
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error()).at("open process token");
    }
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
    let probe_error = io::Error::last_os_error();
    if outcome != 0 || probe_error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) {
        return Err(probe_error).at("size logon SID query");
    }
    // Native TOKEN_GROUPS contains pointers. Use an aligned, bounded buffer.
    check((size_of::<TOKEN_GROUPS>() as u32..=8192).contains(&bytes))
        .at("bound logon SID buffer")?;
    let mut data = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenLogonSid,
            data.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        )
    } == 0
    {
        return Err(io::Error::last_os_error()).at("read logon SID");
    }
    let group = unsafe { &*data.as_ptr().cast::<TOKEN_GROUPS>() };
    check(group.GroupCount == 1).at("exactly one logon SID")?;
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
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut sd,
            null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error()).at("build strict logon ACL");
    }
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
        return Err(io::Error::last_os_error()).at("create first local pipe");
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
    io::stdin()
        .lock()
        .read_exact(&mut bootstrap)
        .at("child read inherited bootstrap")?;
    let id = Uuid::from_bytes(bootstrap[..16].try_into().unwrap());
    let expected_server = u32::from_ne_bytes(bootstrap[16..].try_into().unwrap());
    let mut pipe = client(&pipe_name(id)).at("child open pipe")?;
    check(server_pid(&pipe).at("read server PID")? == expected_server).at("match server PID")?;
    // No pipe name, ticket or payload on command line, stdout or stderr.
    io::stdout().write_all(&[1]).at("write fixed result")?;
    io::stdout().flush()?;
    let mut ticket = [0u8; 16];
    pipe.read_exact(&mut ticket).at("child read ticket")?;
    pipe.write_all(&ticket)?;
    pipe.write_all(&(HTTP_FREE_FIXTURE.len() as u32).to_ne_bytes())?;
    pipe.write_all(HTTP_FREE_FIXTURE.as_bytes())?;
    let mut result = [0u8; 1];
    pipe.read_exact(&mut result).at("child read result")?;
    check(result == [1])
}

fn fixture() -> io::Result<()> {
    // Isolate the negative case on its own first-instance pipe. Reusing its
    // server HANDLE can leave the now-disconnected instance busy until the
    // kernel retires the unpinned client's connection (Win32 231).
    {
        let unpinned_name = pipe_name(Uuid::new_v4());
        let unpinned_server = server(&unpinned_name)?;
        let unrelated = client(&unpinned_name).at("open unpinned fixture endpoint")?;
        connected(&unpinned_server).at("connect preopened endpoint")?;
        check(client_pid(&unpinned_server).at("read fixture client PID")? == std::process::id())
            .at("match fixture client PID")?;
        check(verify_client(&unpinned_server, u32::MAX).is_err())
            .at("refuse unpinned fixture endpoint")?;
        drop(unrelated);
        drop(unpinned_server);
    }

    let id = Uuid::new_v4();
    let name = pipe_name(id);
    let mut pipe = server(&name)?;
    let mut child = Command::new(std::env::current_exe()?)
        .arg("--qualification-child")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .at("spawn isolated transport child")?;
    let result = (|| {
        let mut bootstrap = child.stdin.take().ok_or(io::Error::other("no bootstrap"))?;
        bootstrap
            .write_all(id.as_bytes())
            .at("parent write inherited endpoint")?;
        bootstrap.write_all(&std::process::id().to_ne_bytes())?;
        drop(bootstrap);
        let mut ready = [0];
        child
            .stdout
            .take()
            .ok_or(io::Error::other("no control"))?
            .read_exact(&mut ready)
            .at("receive child readiness")?;
        check(ready == [1]).at("match child readiness")?;
        connected(&pipe).at("connect pinned child endpoint")?;
        verify_client(&pipe, child.id()).at("verify pinned child endpoint")?;

        let mut pickup = BrowserPickup::default();
        let first = Instant::now();
        let ticket = pickup.arm(first);
        pipe.write_all(ticket.as_bytes())
            .at("parent release one-use capability")?;
        let mut wire_ticket = [0; 16];
        pipe.read_exact(&mut wire_ticket)
            .at("parent read echoed capability")?;
        let mut length = [0; 4];
        pipe.read_exact(&mut length)
            .at("parent read bounded header")?;
        let size = u32::from_ne_bytes(length) as usize;
        check((1..=MAX_MESSAGE_BYTES).contains(&size))?;
        let mut frame = vec![0; size + 4];
        frame[..4].copy_from_slice(&length);
        pipe.read_exact(&mut frame[4..])
            .at("parent read bounded fixture")?;
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
        pipe.write_all(&[1]).at("write fixed result")?;
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
