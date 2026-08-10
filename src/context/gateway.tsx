import { createContext, useContext } from "solid-js/dist/solid.js";
import { GatewayClient, createGateway } from "../lib/gateway";

const GatewayContext = createContext<GatewayClient>();

export function useGateway(): GatewayClient {
  const ctx = useContext(GatewayContext);
  if (!ctx) throw new Error("useGateway must be used within a GatewayProvider");
  return ctx;
}

export function GatewayProvider(props: {
  client?: GatewayClient;
  baseUrl?: string;
  children: any;
}) {
  const client = props.client ?? createGateway(props.baseUrl ?? "http://127.0.0.1:20127");
  return (
    <GatewayContext.Provider value={client}>
      {props.children}
    </GatewayContext.Provider>
  );
}
