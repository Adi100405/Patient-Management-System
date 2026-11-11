/**
 * Public entry point for the assistant's tool surface. Routes import from here;
 * the per-role implementations stay private to the folder.
 */
export { executeAssistantTool, toolDefinitionsFor } from "./execute";
export type { ToolHandler } from "./shared";
