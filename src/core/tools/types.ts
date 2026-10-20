// What a surface tool module is: its definition for the bridge, and whether its lane has turned it on. The handler
// that answers a call lives with the lane's feature (src/main/features/) and is registered with AgentHub.handle.
// Pure.
import type { ToolDef } from '../agenttools';

export interface ToolModule {
  def: ToolDef;
  /** Listed by the bridge and callable. Off until the lane that builds the tool is done. */
  enabled: boolean;
}
