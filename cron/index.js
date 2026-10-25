// Calls the Workers Builds deploy hook of the cookbook Worker. A failed call
// throws, so it shows as an error in the Worker's logs.
export default {
  async scheduled(controller, env, ctx) {
    if (!env.DEPLOY_HOOK_URL) throw new Error("DEPLOY_HOOK_URL is not set");
    const response = await fetch(env.DEPLOY_HOOK_URL, { method: "POST" });
    if (!response.ok) throw new Error(`deploy hook returned HTTP ${response.status}`);
  },
};
