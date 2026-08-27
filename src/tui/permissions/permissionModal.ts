import { tuiState } from "../state";
import { sessionTrust } from "../../lib/permissions";

export async function requestApprovalModal(reason: string, args: any): Promise<boolean> {
  const targetKey = args?.command || args?.cmd || args?.path || "";
  return new Promise<boolean>((resolve) => {
    tuiState.pendingConfirmation = {
      prompt: reason,
      onDecision: (choice) => {
        if (choice === "a") {
          sessionTrust.recordDecision(targetKey, targetKey, "SESSION");
        }
      },
      resolve,
    };
    tuiState.requestRender();
  });
}
