import { NEUTRAL_INPUT } from "../../shared/protocol.js";

/**
 * Glue for a browser game simulation. The host runs every simulation tick;
 * guests only submit their input and apply host snapshots. The simulation
 * object is intentionally small so the game can choose its own ECS/renderer:
 *
 *   step({ tick, hostInput, guestInput })
 *   createSnapshot()
 *   applySnapshot({ tick, state })
 *   applyEvent({ tick, event })       // optional
 */
export class AuthoritativeCoopSession {
  #unsubscribe;
  #latestGuestInput = { ...NEUTRAL_INPUT };
  #lastGuestSequence = -1;

  constructor({ client, simulation, snapshotEveryTicks = 3 }) {
    if (!Number.isInteger(snapshotEveryTicks) || snapshotEveryTicks < 1) {
      throw new TypeError("snapshotEveryTicks must be a positive integer");
    }
    this.client = client;
    this.simulation = simulation;
    this.snapshotEveryTicks = snapshotEveryTicks;
  }

  start() {
    if (this.#unsubscribe) {
      return;
    }
    this.#unsubscribe = this.client.onMessage((message) => this.receive(message));
    this.client.setReady(true);
  }

  stop() {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /** Call this once per fixed simulation tick with the local player's input. */
  tick(tick, localInput) {
    if (this.client.playerId === 0) {
      this.simulation.step({
        tick,
        hostInput: localInput,
        guestInput: this.#latestGuestInput,
      });
      if (tick % this.snapshotEveryTicks === 0) {
        this.client.sendSnapshot(tick, this.simulation.createSnapshot());
      }
      return;
    }

    if (this.client.playerId === 1) {
      this.client.sendInput(tick, localInput);
    }
  }

  sendEvent(tick, event) {
    return this.client.sendEvent(tick, event);
  }

  receive(message) {
    if (message.type === "input" && this.client.playerId === 0) {
      // TCP/WebSocket preserves ordering, but retaining the sequence guard makes
      // role reconnection and accidental duplicate dispatch harmless.
      if (message.seq > this.#lastGuestSequence) {
        this.#lastGuestSequence = message.seq;
        this.#latestGuestInput = message.input;
      }
      return;
    }

    if (message.type === "snapshot" && this.client.playerId === 1) {
      this.simulation.applySnapshot({ tick: message.tick, state: message.state });
      return;
    }

    if (message.type === "event" && this.client.playerId === 1) {
      this.simulation.applyEvent?.({ tick: message.tick, event: message.event });
    }
  }
}
