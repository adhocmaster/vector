import { register } from "prom-client";
import { ChannelSigner } from "@connext/vector-utils";

// import { signer } from "..";
import { IRouterMessagingService } from "./messaging";

let signer: any | ChannelSigner = null; // will be injected

export const startMetricsBroadcastTaskWithSigner = (signerReplacement: ChannelSigner, interval: number, messaging: IRouterMessagingService): void => {
  signer = signerReplacement;
  setInterval(() => {
    metricsBroadcastTasks(messaging);
  }, interval);
};

export const startMetricsBroadcastTask = (interval: number, messaging: IRouterMessagingService): void => {

  if (!signer) {
    throw Error("signer cannot be none. Are you using startMetricsBroadcastTask?")
  }
  setInterval(() => {
    metricsBroadcastTasks(messaging);
  }, interval);
};

export const metricsBroadcastTasks = async (messaging: IRouterMessagingService) => {
  const metrics = await register.metrics();
  await messaging.broadcastMetrics(signer.publicIdentifier, metrics);
};
