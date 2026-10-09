// Engine memory layout of the vel.gg browser build, by the SHA-256 of KisakBlack-web.wasm.
// Every address below was read from that exact binary (function names come from its name section);
// another build moves them, so co-op refuses to patch a build it does not know.
// See browser-coop/README.md ("When vel.gg updates the engine") to add a build.

export const BUILDS = {
  // KisakBlack-web.wasm served by https://vel.gg/bo1z/ since 2026-10-04 (9,618,325 bytes)
  "61192df377020627f52fa7e9fd28047bd53662aa46e5e3cd6e7fad0c5c35cc98": {
    // Functions patched or called by the patch: index (imports included) and expected name.
    functions: {
      svFrame: [3646, "__wrap__Z8SV_Frameii"],
      netGetLoopPacket: [4026, "NET_GetLoopPacket(netsrc_t, netadr_t*, msg_t*)"],
      cbufAddText: [291, "Cbuf_AddText(int, char const*)"],
      svWaitServer: [1391, "SV_WaitServer()"],
      // Debug-check handler: prints "KISAK_HEADLESS assert ..." then traps. In co-op it returns 1 (continue) instead.
      assertHandler: [170, "Assert_MyHandler(char const*, int, int, char const*, ...)"],
      // Attaches effects and weapons to another player's body. Fatal when that player's model is not there yet,
      // which solo play never meets; in co-op the two errors become "leave the tag as it was".
      cachedTagUpdate: [4317, "CachedTag_UpdateTagInternal(centity_s const*, cached_client_tag_t*, unsigned int, int, bool)"],
      comError: [179, "Com_Error(errorParm_t, char const*, ...)"],
    },
    // Three words of zero padding between web-layer statics, referenced by no instruction.
    // The patch uses them as cross-thread mailboxes: CMD (char* console command), FREEZE (bool), INQ (ring index).
    flags: { cmd: 148263172, freeze: 148263176, inq: 148263180 },
    // loopback_t loopbacks[2]: ring 0 = server -> local client, ring 1 = clients -> server.
    // Each ring: 16 msgs of { u8 data[1264]; i32 datalen; i32 port } then i32 get, i32 send.
    // Sends pick the ring with to.port when sock == NS_SERVER, without a bounds check: port P writes base + P * stride.
    loopback: { base: 135783616, stride: 20360, slots: 16, slotSize: 1272, dataMax: 1264, offLen: 1264, offPort: 1268, offGet: 20352, offSend: 20356 },
    // Ports 0 and 1 are the real rings; this one maps onto engine data in this build.
    forbiddenPorts: [0, 1, 1773],
    server: {
      allowNetPackets: 142494258, // u8 sv.allowNetPackets: the server thread drains ring 1 only while 1
      clientsPtr: 142360860, // client_t* svs.clients
      clientStride: 544120,
      clientState: 0, // i32 clientState_t: 0 free, 1 zombie, 2 reconnecting, 3 connected, 4 loading, 5 active
      clientAddrType: 32, // i32 netadr_t.type
      clientAddrPort: 40, // u16 netadr_t.port
      clientConnectState: 544089, // u8 last connection state the client reported (10 = active)
    },
    client: {
      connectionState: 13391960, // i32 clientUIActive.connectionState: 5 challenging .. 10 active
      clcPtr: 43783020, // clientConnection_t* (serverAddress.port is a u16 at +24)
      serverAddressPort: 24,
      lastPacketTime: 12, // i32 clc->lastPacketTime; the engine skips its connection timeout while it is 0
    },
    // Pointers to dvar_s; the current value is at +24.
    dvars: { comSvRunning: 134904904, svPaused: 134904892, clPaused: 134904896, comMaxClients: 134904752 },
    dvarValue: 24,
    browser: { mapLoadedPrinted: 148263157, introState: 148263168 },
    netadrLoopback: 2, // NA_LOOPBACK
  },
};

// connstate_t of the local client (client.connectionState).
export const CONNECTION = Object.freeze({ disconnected: 0, connecting: 4, challenging: 5, connected: 6, sendingStats: 7, loading: 8, primed: 9, active: 10 });
// clientState_t of a server slot.
export const CLIENT_STATE = Object.freeze({ free: 0, zombie: 1, reconnecting: 2, connected: 3, loading: 4, active: 5 });
