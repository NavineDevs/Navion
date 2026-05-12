const NAVION_PIPELINE_HOOKS = {
  beforeRequest: [],
  afterResponse: [],
  onError: [],
};

export function useNavionHook(type, handler) {
  if (!NAVION_PIPELINE_HOOKS[type]) {
    throw new Error(`Unknown NAVION hook type: ${type}`);
  }
  if (typeof handler !== "function") {
    throw new TypeError("NAVION hook handler must be a function");
  }
  NAVION_PIPELINE_HOOKS[type].push(handler);
  return () => {
    const idx = NAVION_PIPELINE_HOOKS[type].indexOf(handler);
    if (idx !== -1) NAVION_PIPELINE_HOOKS[type].splice(idx, 1);
  };
}

export async function runNavionHooks(type, payload) {
  const list = NAVION_PIPELINE_HOOKS[type];
  if (!list || list.length === 0) return;
  for (const hook of list) {
    await hook(payload);
  }
}

