#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_named_configurable_corners() {
        assert!(matches!(Corner::parse("top-right"), Some(Corner::TopRight)));
        assert!(matches!(
            Corner::parse("bottom-left"),
            Some(Corner::BottomLeft)
        ));
        assert!(Corner::parse("none").is_none());
    }

    #[test]
    fn negative_origin_and_mixed_dpi_respect_work_area_and_corner() {
        let monitor = Bounds {
            x: -1920,
            y: 100,
            w: 1920,
            h: 1080,
        };
        let work = Bounds { h: 1036, ..monitor };
        let app = Bounds {
            x: -1740,
            y: 120,
            w: 1200,
            h: 950,
        };
        let bottom = place(Some(app), monitor, work, 1.5, Corner::BottomRight).unwrap();
        assert_eq!(bottom, (-522, 890, 498, 222));
        let top = place(Some(app), monitor, work, 1.5, Corner::TopLeft).unwrap();
        assert_eq!(top, (-1896, 124, 498, 222));
    }

    #[test]
    fn suppresses_fullscreen_with_border_bleed_unknown_scale_and_cramped_display() {
        let monitor = Bounds {
            x: -1920,
            y: 100,
            w: 1920,
            h: 1080,
        };
        let bleed = Bounds {
            x: -1928,
            y: 92,
            w: 1936,
            h: 1096,
        };
        assert!(place(Some(bleed), monitor, monitor, 1.5, Corner::BottomRight).is_none());
        assert!(place(None, monitor, monitor, f64::NAN, Corner::BottomRight).is_none());
        assert!(place(
            None,
            monitor,
            Bounds { w: 300, ..monitor },
            1.5,
            Corner::BottomRight
        )
        .is_none());
    }
}

#[derive(Clone, Copy, Default)]
pub(crate) enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    #[default]
    BottomRight,
}

impl Corner {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "top-left" => Some(Self::TopLeft),
            "top-right" => Some(Self::TopRight),
            "bottom-left" => Some(Self::BottomLeft),
            "bottom-right" => Some(Self::BottomRight),
            _ => None,
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Bounds {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

pub(crate) const WIDTH: f64 = 332.0;
pub(crate) const HEIGHT: f64 = 148.0;

pub(crate) fn place(
    active: Option<Bounds>,
    monitor: Bounds,
    work: Bounds,
    dpi: f64,
    corner: Corner,
) -> Option<(i32, i32, u32, u32)> {
    if !(1.0..=8.0).contains(&dpi) {
        return None;
    }
    let edge = |position: i32, size: u32| i64::from(position) + i64::from(size);
    // Suppress applications at or beyond all four monitor edges (including composition bleed).
    if active.is_some_and(|app| {
        i64::from(app.x) <= i64::from(monitor.x) + 2
            && i64::from(app.y) <= i64::from(monitor.y) + 2
            && edge(app.x, app.w) >= edge(monitor.x, monitor.w) - 2
            && edge(app.y, app.h) >= edge(monitor.y, monitor.h) - 2
    }) {
        return None;
    }
    let width = (WIDTH * dpi).round() as u32;
    let height = (HEIGHT * dpi).round() as u32;
    let margin = (16.0 * dpi).round() as u32;
    if work.w < width + 2 * margin || work.h < height + 2 * margin {
        return None;
    }
    let left = matches!(corner, Corner::TopLeft | Corner::BottomLeft);
    let top = matches!(corner, Corner::TopLeft | Corner::TopRight);
    let x = work.x.checked_add(
        i32::try_from(if left {
            margin
        } else {
            work.w - width - margin
        })
        .ok()?,
    )?;
    let y = work.y.checked_add(
        i32::try_from(if top {
            margin
        } else {
            work.h - height - margin
        })
        .ok()?,
    )?;
    Some((x, y, width, height))
}
