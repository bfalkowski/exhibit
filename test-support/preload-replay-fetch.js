// Loaded with `node --import` in CLI tests. It swaps the global fetch for one that replays the
// fixture file named in EXHIBIT_TEST_FIXTURE, so the spawned command never reaches the network.
import { replayFetch } from './replay-fetch.js';

globalThis.fetch = replayFetch(process.env.EXHIBIT_TEST_FIXTURE);
