import { CreateTripInput, DriverGoOnlineDto, TripActionDto } from "@rukwaride/shared";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `API ${status}: ${JSON.stringify(body)}`);
  }
}

async function request<T>(
  apiUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

export const api = {
  createTrip: (apiUrl: string, token: string, dto: CreateTripInput) =>
    request<{ id: string; status: string; estimatedFare: number }>(apiUrl, token, "POST", "/trips", dto),

  getTrip: (apiUrl: string, token: string, tripId: string) =>
    request<{
      id: string;
      status: string;
      kind: string;
      vehicleClass: string;
      driverId: string | null;
      offeredDriverIds: string[];
      offerSeq: number;
      estimatedFare: number;
      finalFare: number | null;
      finalDistanceM: number | null;
      finalDurationS: number | null;
      fareBreakdown: unknown;
      cancellationFee: number | null;
      paymentMethod: string;
      scheduledAt: string | null;
      recipient: { name: string; phone: string } | null;
      packageNote: string | null;
    }>(apiUrl, token, "GET", `/trips/${tripId}`),

  cancelTrip: (apiUrl: string, token: string, tripId: string, reason?: string) =>
    request(apiUrl, token, "POST", `/trips/${tripId}/cancel`, { reason }),

  setDriverStatus: (apiUrl: string, token: string, dto: DriverGoOnlineDto) =>
    request<{ status: string }>(apiUrl, token, "POST", "/drivers/me/status", dto),

  tripAction: (apiUrl: string, token: string, tripId: string, dto: TripActionDto) =>
    request<{ status: string }>(apiUrl, token, "POST", `/trips/${tripId}/action`, dto),

  postLocationBatch: (apiUrl: string, token: string, points: Array<{ lat: number; lng: number; recordedAt: number }>) =>
    request(apiUrl, token, "POST", "/drivers/me/locations", { points }),
};
