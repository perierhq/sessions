// Shared limits of "What the agents did": a leaf module with no imports, so
// the route that serves it and the findings tool that reads the same tail
// can both use it without importing each other.

/** Transcript entries read per agent for its tool calls. */
export const AGENT_AUDIT_TAIL = 2000;
