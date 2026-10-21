"use client";

import { io, Socket } from "socket.io-client";
import { API_URL, getToken } from "./api";

let socket: Socket | null = null;

/** Lazy singleton /passenger socket; reconnects are socket.io's job. */
export function passengerSocket(): Socket {
  if (!socket || socket.disconnected) {
    socket?.close();
    socket = io(`${API_URL}/passenger`, {
      transports: ["websocket", "polling"],
      auth: { token: getToken() },
      reconnection: true,
      reconnectionDelay: 1000,
    });
  }
  return socket;
}

export function closePassengerSocket() {
  socket?.close();
  socket = null;
}
