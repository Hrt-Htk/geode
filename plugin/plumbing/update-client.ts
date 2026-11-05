import { httpBase, HttpStatusError, request } from "./provisioning-client.ts";

// #44: the calls behind the plugin's server update, beside the routes in server/update-routes.ts.
// All three ride the platform HTTP layer (requestUrl on desktop, fetch on mobile), so the phone
// can reach them too.

/** A result the job wrote: `<status> <epoch>`, one of the words in server.md §11. */
export type JobResult = { word: string; epoch: number };

export type JobStatus = {
  /** A heartbeat younger than three minutes: the job is installed. */
  installed: boolean;
  result: JobResult | null;
};

/** Leave the empty request the host job answers; the epoch dates it, see `freshResult`. */
export async function requestServerUpdate(
  serverUrl: string,
  adminToken: string,
): Promise<{ epoch: number }> {
  const url = `${httpBase(serverUrl)}/update`;
  return (await request(url, "POST", adminToken)) as { epoch: number };
}

/** The job's state. A server that predates the route answers not installed, never an error. */
export async function fetchUpdateStatus(
  serverUrl: string,
  deviceToken: string,
): Promise<JobStatus> {
  const url = `${httpBase(serverUrl)}/update/status`;
  try {
    return (await request(url, "GET", deviceToken)) as JobStatus;
  } catch (e) {
    if (e instanceof HttpStatusError && e.status === 404) {
      return { installed: false, result: null };
    }
    throw e;
  }
}

/** The version the server runs now: the one an update changes. */
export async function fetchServerVersion(serverUrl: string): Promise<string> {
  const body = (await request(`${httpBase(serverUrl)}/version`, "GET", null)) as {
    version: string;
  };
  return body.version;
}
