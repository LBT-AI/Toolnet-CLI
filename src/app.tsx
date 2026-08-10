import { createGateway } from "./lib/gateway";
import { ChatScreen } from "./screens/chat";

export function App() {
  createGateway();
  return <ChatScreen />;
}
