import { doctorDefinitions, doctorHandlers } from "./doctor";
import { patientDefinitions, patientHandlers } from "./patient";
import type { ToolHandler } from "./shared";
import type { AssistantContext, ToolDefinition, ToolOutcome } from "@/lib/assistant/types";

/**
 * The role gate lives here, at the dispatch table, not only in the prompt. A
 * model that hallucinates a tool name it does not have — or a patient who
 * crafts the assistant request by hand — gets an ordinary error result, never a
 * doctor query.
 */
const TOOLSETS: Record<AssistantContext["role"], {
  definitions: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
}> = {
  doctor: { definitions: doctorDefinitions, handlers: doctorHandlers },
  patient: { definitions: patientDefinitions, handlers: patientHandlers },
};

export function toolDefinitionsFor(role: AssistantContext["role"]): ToolDefinition[] {
  return TOOLSETS[role].definitions;
}

export async function executeAssistantTool(
  name: string,
  rawArgs: string,
  ctx: AssistantContext,
): Promise<ToolOutcome> {
  const handler = TOOLSETS[ctx.role].handlers[name];
  if (!handler) {
    return {
      result: {
        error: `The ${name} tool is not available for a ${ctx.role} session. Stay inside your role.`,
      },
    };
  }

  let args: unknown = {};
  if (rawArgs.trim()) {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      return { result: { error: "The tool arguments were not valid JSON." } };
    }
  }

  try {
    return await handler(args, ctx);
  } catch (error) {
    // Tool failures are model-readable, not 500s: the assistant can explain a
    // bad query or a database hiccup and offer the next step.
    return {
      result: {
        error: error instanceof Error ? error.message : "The tool failed unexpectedly.",
      },
    };
  }
}
