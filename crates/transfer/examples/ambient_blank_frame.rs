//! Emits only a fabricated all-black media-foundation-style proof fixture.
//! No arguments, files, camera, OS calls, IPC or networking.
use aerift_transfer::ambient_camera::RgbFrame;
use std::{
    io::{self, Write},
    time::Instant,
};

fn main() -> io::Result<()> {
    const WIDTH: u16 = 256;
    const HEIGHT: u16 = 256;
    const STRIDE: usize = 1028;
    let mut bgra = vec![0; usize::from(HEIGHT) * STRIDE];
    for row in bgra.chunks_exact_mut(STRIDE) {
        for pixel in row[..usize::from(WIDTH) * 4].chunks_exact_mut(4) {
            pixel[3] = 255;
        }
        row[usize::from(WIDTH) * 4..].fill(219);
    }
    let frame = RgbFrame::from_mf_rgb32(Instant::now(), WIDTH, HEIGHT, -(STRIDE as i32), &bgra)
        .expect("synthetic proof layout is valid");
    io::stdout().lock().write_all(frame.rgb())
}
