import { io, Socket } from "socket.io-client";
import { getAccessToken } from "./api";
import { API_URL } from "./config";

let socket: Socket | null = null;

export function driverSocket(): Socket {
  if (!socket) {
    socket = io(`${API_URL}/driver`, {
      transports: ["websocket"],
      auth: { token: getAccessToken() },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });
  }
  return socket;
}

export function closeDriverSocket(): void {
  socket?.close();
  socket = null;
}
