export function fakeFetch(routes, calls = []) {
  return async (url, options = {}) => {
    const canonical = String(url);
    calls.push({ url: canonical, options: structuredClone(options) });
    const route = routes[canonical];
    if (route === undefined) throw new Error(`unexpected fake fetch: ${canonical}`);
    const value = Array.isArray(route) ? route.shift() : route;
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value(canonical, options);
    const status = value.status ?? 200;
    return new Response(status === 204 || status === 304 ? null : (value.body ?? ''), {
      status,
      headers: value.headers ?? { 'content-type': 'text/plain' }
    });
  };
}

export const publicResolution = async () => [{ address: '93.184.216.34', family: 4 }];
