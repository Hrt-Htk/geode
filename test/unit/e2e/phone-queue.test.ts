// Unit tests for the FIFO ticket queue (#508). Pure parts only: registering a
// real ticket needs the /tmp queue dir.

import { assertEquals } from "@std/assert";
import {
  orderTickets,
  parseTicketName,
  pruneStaleTickets,
  queuePosition,
  type Ticket,
  ticketFileName,
} from "../../../test/e2e/phone-queue.ts";

const T = (pid: number, waitingSince: number): Ticket => ({
  worktree: `wt-${pid}`,
  pid,
  waitingSince,
});

const alive = (pid: number) => pid !== 999;

Deno.test("ticketFileName embeds monotonic time and pid", () => {
  assertEquals(ticketFileName(1_700_000_000_000, 42), "1700000000000-42");
});

Deno.test("parseTicketName round-trips and rejects junk", () => {
  assertEquals(parseTicketName("1700000000000-42"), { waitingSince: 1_700_000_000_000, pid: 42 });
  assertEquals(parseTicketName("junk"), null);
  assertEquals(parseTicketName("12"), null);
  assertEquals(parseTicketName("a-42"), null);
  assertEquals(parseTicketName("1700000000000-x"), null);
});

Deno.test("orderTickets sorts by waitingSince then pid", () => {
  const a = T(1, 200);
  const b = T(2, 100);
  const c = T(3, 100);
  assertEquals(orderTickets([a, b, c]), [b, c, a]); // time first, pid breaks the tie
});

Deno.test("pruneStaleTickets drops dead-pid tickets", () => {
  const aliveT = T(1, 100);
  const deadT = T(999, 50);
  assertEquals(pruneStaleTickets([aliveT, deadT], alive), [aliveT]);
});

Deno.test("queuePosition is 1-based and null when absent", () => {
  const tickets = [T(1, 100), T(2, 200), T(3, 300)];
  assertEquals(queuePosition(tickets, 1, alive), 1);
  assertEquals(queuePosition(tickets, 3, alive), 3);
  assertEquals(queuePosition(tickets, 42, alive), null);
});

Deno.test("queuePosition skips dead earlier tickets so the waiter moves up", () => {
  const deadHead = T(999, 50); // died before the run started
  const us = T(2, 200);
  const late = T(3, 300);
  assertEquals(queuePosition([deadHead, us, late], 2, alive), 1);
});
