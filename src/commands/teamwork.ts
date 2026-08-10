import type { CommandContext, Command } from "./index";
import { EventBus } from "../teamwork/eventBus";
import { DynamicScheduler } from "../teamwork/dynamicScheduler";
import { generateTaskGraph, getGraphNodeArray } from "../teamwork/smartPlanner";
import { setIsDashboardActive, setDashboardNodes, setDashboardState } from "../teamwork/dashboardState";

export const teamworkCommand: Command = {
  name: "teamwork",
  aliases: ["team", "tw"],
  description: "Khởi động ToolNet Teamwork v2 Orchestrator",
  usage: "/teamwork <prompt> [--budget=economy|performance] [--quality=fast|production]",
  handler: async (args: string[], ctx: CommandContext) => {
    if (args.length === 0) {
      ctx.addMessage("assistant", "Vui lòng cung cấp yêu cầu cho Teamwork. Ví dụ: `/teamwork Viết game rắn săn mồi`");
      return;
    }

    const prompt = args.join(" ");
    ctx.setStatusMsg("Khởi động Teamwork v2...");
    
    // Create an event bus instance
    const eventBus = new EventBus();
    const sessionId = Date.now().toString();
    
    // Log the event
    eventBus.emit("TaskCreated", { sessionId, prompt });

    // Inform the user
    ctx.addMessage(
      "assistant",
      `🚀 **ToolNet Teamwork v2** đã tiếp nhận yêu cầu!\n\n` +
      `**Prompt:** ${prompt}\n` +
      `**Session ID:** ${sessionId}\n\n` +
      `*Hệ thống đang nạp thẻ mô hình, khởi tạo Context Cache và lập kế hoạch (JSON Task Graph)...*`
    );

    ctx.setStatusMsg("Đang lập kế hoạch (Smart Planner)...");
    
    try {
      const taskGraph = await generateTaskGraph(prompt, undefined, { 
        sessionId, 
        eventBus,
        gatewayUrl: (ctx as any).gateway?.url || (ctx as any).config?.gatewayUrl // Optional fallback
      });

      ctx.addMessage(
        "assistant",
        `✅ Lập kế hoạch hoàn tất. Đang khởi chạy Dynamic Scheduler với ${taskGraph.nodes?.length || 0} node...`
      );

      ctx.setStatusMsg("Teamwork Orchestrator đang chạy...");
      
      const scheduler = new DynamicScheduler(taskGraph, {
        maxConcurrencyOverride: undefined
      });
      
      setIsDashboardActive(true);
      setDashboardNodes(getGraphNodeArray(taskGraph));
      setDashboardState(scheduler.getState());

      scheduler.onEvent((event) => {
        setDashboardNodes([...(scheduler as any).nodesList]);
        setDashboardState(scheduler.getState());
      });
      
      const result = await scheduler.start();
      
      ctx.addMessage(
        "assistant",
        `🎉 **Teamwork hoàn thành!** Trạng thái: ${result.status}`
      );
      ctx.setStatusMsg("");
    } catch (error: any) {
      ctx.addMessage("assistant", `❌ Lỗi khi thực thi Teamwork: ${error.message}`);
      ctx.setStatusMsg("");
    }
  },
};
