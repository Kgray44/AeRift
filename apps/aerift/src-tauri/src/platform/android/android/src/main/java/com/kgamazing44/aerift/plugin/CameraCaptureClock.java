package com.kgamazing44.aerift.plugin;

/** Converts Camera2 sample timestamps to the event clock without aging them from receipt time. */
final class CameraCaptureClock {
    private static final long FRAME_INTERVAL_NS = 75_000_000L;
    private static final long MAX_AGE_NS = 150_000_000L;
    private long lastSensor = -1;
    private long lastCapture = -1;

    /** Worker-only. Returns -1 if the frame is expired, replayed, too frequent, or incompatible. */
    long accept(long sensor, long elapsed, long uptime, boolean realtime) {
        if (sensor <= lastSensor || sensor <= 0) return -1;
        // An incompatible clock or a dropped frame cannot justify replaying this sensor sample.
        lastSensor = sensor;
        final long capture;
        try {
            // UNKNOWN Camera2 timestamps are approximately in the uptime time domain.
            // Convert and fail closed if that device's offset doesn't pass freshness.
            capture = realtime ? sensor : Math.addExact(sensor, Math.subtractExact(elapsed, uptime));
        } catch (ArithmeticException invalidTimestamp) {
            return -1;
        }
        if (!isFresh(capture, elapsed) ||
            (lastCapture >= 0 && capture - lastCapture < FRAME_INTERVAL_NS)) {
            return -1;
        }
        lastCapture = capture;
        return capture;
    }

    static boolean isFresh(long capture, long elapsed) {
        return capture > 0 && capture <= elapsed && elapsed - capture <= MAX_AGE_NS;
    }
}
