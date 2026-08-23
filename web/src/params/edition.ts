import type { ParamMatcher } from "@sveltejs/kit";

/** The two editions of the About document. Anything else is a 404. */
export const match: ParamMatcher = (p) => p === "short" || p === "full";
