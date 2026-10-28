/**
 * Barramento de eventos de domínio. Os serviços publicam com as salas de destino; a camada
 * Socket.IO (realtime.ts) apenas repassa. Assim a regra "quem recebe o quê" (RN03/RNF06) fica
 * nos serviços e é testável sem rede.
 */
export interface Published {
  rooms: string[];
  event: string;
  payload: unknown;
}

export const rooms = {
  sector: (id: string) => `sector:${id}`,
  user: (id: string) => `user:${id}`,
  admins: 'admins',
} as const;

export class EventBus {
  private readonly listeners = new Set<(p: Published) => void>();

  publish(roomList: string[], event: string, payload: unknown): void {
    const p: Published = { rooms: [...new Set(roomList)], event, payload };
    for (const l of this.listeners) l(p);
  }

  subscribe(cb: (p: Published) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }
}

/** Salas que devem ver uma conversa: o setor (se houver) e sempre os administradores. */
export const conversationRooms = (sectorId: string | null): string[] =>
  sectorId ? [rooms.sector(sectorId), rooms.admins] : [rooms.admins];
