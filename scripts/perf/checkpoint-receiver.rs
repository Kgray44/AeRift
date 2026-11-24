mod input;
use input::{Checkpoint, MAX_BLOCK};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    time::Instant,
};
fn main() {
    let mode = std::env::args().nth(1).unwrap();
    let root = std::path::PathBuf::from(std::env::args_os().nth(2).unwrap());
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("deterministic-128m.bin");
    let size = 128 * MAX_BLOCK;
    if mode == "generate" {
        let mut f = File::create(path).unwrap();
        for j in 0..128 {
            let bytes = (0..MAX_BLOCK)
                .map(|i| ((i.wrapping_mul(77) ^ j) ^ i.rotate_left(5)) as u8)
                .collect::<Vec<u8>>();
            f.write_all(&bytes).unwrap();
        }
        f.sync_all().unwrap();
        return;
    }
    let mut f = File::open(path).unwrap();
    let mut buffer = vec![0u8; MAX_BLOCK];
    let mut source_hash = Sha256::new();
    assert_eq!(f.metadata().unwrap().len(), size as u64);
    for _ in 0..128 {
        f.read_exact(&mut buffer).unwrap();
        source_hash.update(&buffer);
    }
    use std::io::Seek;
    f.rewind().unwrap();
    let digest: [u8; 32] = source_hash.finalize().into();
    let mut c = Checkpoint::create(&root, size as u64, digest).unwrap();
    let start = Instant::now();
    for i in 0..128u64 {
        f.read_exact(&mut buffer).unwrap();
        assert_eq!(
            append(&mut c, i * MAX_BLOCK as u64, &buffer).unwrap(),
            (i + 1) * MAX_BLOCK as u64
        );
    }
    let append_ms = start.elapsed().as_secs_f64() * 1000.;
    let finish = Instant::now();
    let stage = c.finish().unwrap();
    let finish_ms = finish.elapsed().as_secs_f64() * 1000.;
    assert_eq!(stage.as_file().metadata().unwrap().len(), size as u64);
    let proc_status = std::fs::read_to_string("/proc/self/status").unwrap();
    let vmhwm = proc_status
        .lines()
        .find(|line| line.starts_with("VmHWM:"))
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap();
    println!(
        "max_rss_kib={vmhwm} append_ms={append_ms:.3} finish_ms={finish_ms:.3} total_mibps={:.2}",
        128. / ((append_ms + finish_ms) / 1000.)
    );
}
fn append(c: &mut Checkpoint, start: u64, data: &[u8]) -> Result<u64, input::Error> {
    #[cfg(not(aerift_p4_baseline))]
    return c.append_block(start, data);
    #[cfg(aerift_p4_baseline)]
    return c.append(
        start,
        data.len(),
        Sha256::digest(data).into(),
        &mut std::io::Cursor::new(data),
    );
}
