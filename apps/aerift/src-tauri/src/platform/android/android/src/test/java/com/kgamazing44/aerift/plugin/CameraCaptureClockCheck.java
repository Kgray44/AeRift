package com.kgamazing44.aerift.plugin;

/** JVM-only clock checks: run with javac and java, without a device or Kotlin SDK. */
public final class CameraCaptureClockCheck {
    private static final long MS = 1_000_000L;

    public static void main(String[] args) {
        CameraCaptureClock realtime = new CameraCaptureClock();
        equal(1_000 * MS, realtime.accept(1_000 * MS, 1_040 * MS, 400 * MS, true));
        equal(-1, realtime.accept(1_000 * MS, 1_050 * MS, 410 * MS, true)); // reused buffer
        equal(-1, realtime.accept(1_074 * MS, 1_075 * MS, 420 * MS, true));
        equal(1_075 * MS, realtime.accept(1_075 * MS, 1_225 * MS, 500 * MS, true));
        equal(-1, realtime.accept(1_150 * MS, 1_301 * MS, 600 * MS, true));
        equal(-1, realtime.accept(1_250 * MS, 1_240 * MS, 610 * MS, true));
        equal(-1, realtime.accept(0, 1_300 * MS, 610 * MS, true));

        CameraCaptureClock uptime = new CameraCaptureClock();
        equal(4_980 * MS, uptime.accept(980 * MS, 5_000 * MS, 1_000 * MS, false));
        equal(-1, uptime.accept(980 * MS, 5_090 * MS, 1_060 * MS, false));
        equal(5_070 * MS, uptime.accept(1_070 * MS, 5_090 * MS, 1_090 * MS, false));
        equal(-1, uptime.accept(Long.MAX_VALUE, 5_100 * MS, 1_100 * MS, false));
        if (CameraCaptureClock.isFresh(1_000 * MS, 1_151 * MS)) throw new AssertionError("late UI delivery");
        if (CameraCaptureClock.isFresh(1_000 * MS, 999 * MS)) throw new AssertionError("future UI delivery");
        System.out.println("Android camera clock: fresh, replay, cadence, expiry and uptime cases passed.");
    }

    private static void equal(long expected, long actual) {
        if (expected != actual) throw new AssertionError("expected " + expected + " but got " + actual);
    }
}
