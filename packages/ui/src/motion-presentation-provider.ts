import { PUBLIC_MOTION_PRESENTATION, type MotionPresentationProvider } from "./motion-presentation-contract";

// Canonical public profile. The application has no runtime import or network
// path for third-party motion tuning. Reviewed private builds may substitute
// this exact importer/specifier at build time, independently of app authority.
export default PUBLIC_MOTION_PRESENTATION satisfies MotionPresentationProvider;
