import { describe, it, expect, beforeEach } from "vitest";
import { stringAsciiCV, uintCV, principalCV, noneCV, someCV } from "@stacks/transactions";

const ERR_NOT_AUTHORIZED = 100;
const ERR_INVALID_BOOKING = 101;
const ERR_ALREADY_DEPOSITED = 102;
const ERR_NO_DEPOSIT = 103;
const ERR_DISPUTE_ACTIVE = 104;
const ERR_INVALID_AMOUNT = 105;
const ERR_INVALID_STATUS = 106;
const ERR_NOT_ADMIN = 109;

interface Escrow {
  traveler: string;
  guide: string;
  amount: number;
  status: string;
  disputeActive: boolean;
  depositTime: number;
  feeAmount: number;
}

interface Booking {
  status: string;
  guide: string;
}

interface Result<T> {
  ok: boolean;
  value: T;
}

class EscrowMock {
  state: {
    admin: string;
    platformFee: number;
    escrows: Map<number, Escrow>;
    bookingContracts: Map<number, string>;
  } = {
    admin: "ST1ADMIN",
    platformFee: 100,
    escrows: new Map(),
    bookingContracts: new Map(),
  };
  blockHeight: number = 0;
  caller: string = "ST1TRAVELER";
  stxTransfers: Array<{ amount: number; from: string; to: string }> = [];

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      admin: "ST1ADMIN",
      platformFee: 100,
      escrows: new Map(),
      bookingContracts: new Map(),
    };
    this.blockHeight = 0;
    this.caller = "ST1TRAVELER";
    this.stxTransfers = [];
  }

  getEscrowDetails(bookingId: number): Escrow | null {
    return this.state.escrows.get(bookingId) || null;
  }

  getPlatformFee(): Result<number> {
    return { ok: true, value: this.state.platformFee };
  }

  getBookingContract(contractId: number): Result<string | null> {
    return { ok: true, value: this.state.bookingContracts.get(contractId) || null };
  }

  setPlatformFee(fee: number): Result<boolean> {
    if (this.caller !== this.state.admin) return { ok: false, value: ERR_NOT_ADMIN };
    if (fee <= 0) return { ok: false, value: ERR_INVALID_FEE };
    this.state.platformFee = fee;
    return { ok: true, value: true };
  }

  setBookingContract(contractId: number, contractPrincipal: string): Result<boolean> {
    if (this.caller !== this.state.admin) return { ok: false, value: ERR_NOT_ADMIN };
    this.state.bookingContracts.set(contractId, contractPrincipal);
    return { ok: true, value: true };
  }

  async validateBooking(bookingId: number): Promise<Result<Booking>> {
    if (!this.state.bookingContracts.get(1)) return { ok: false, value: ERR_NOT_AUTHORIZED };
    return { ok: true, value: { status: "confirmed", guide: "ST1GUIDE" } };
  }

  depositPayment(bookingId: number, amount: number): Result<boolean> {
    if (this.state.escrows.has(bookingId)) return { ok: false, value: ERR_ALREADY_DEPOSITED };
    if (amount <= 0) return { ok: false, value: ERR_INVALID_AMOUNT };
    if (!this.validateBooking(bookingId).then(r => r.ok)) return { ok: false, value: ERR_INVALID_BOOKING };
    const fee = this.state.platformFee;
    this.stxTransfers.push({ amount: fee, from: this.caller, to: this.state.admin });
    this.stxTransfers.push({ amount: amount - fee, from: this.caller, to: "contract" });
    this.state.escrows.set(bookingId, {
      traveler: this.caller,
      guide: "ST1GUIDE",
      amount: amount - fee,
      status: "deposited",
      disputeActive: false,
      depositTime: this.blockHeight,
      feeAmount: fee,
    });
    return { ok: true, value: true };
  }

  releasePayment(bookingId: number): Result<boolean> {
    const escrow = this.state.escrows.get(bookingId);
    if (!escrow) return { ok: false, value: ERR_NO_DEPOSIT };
    if (escrow.traveler !== this.caller) return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (escrow.status !== "deposited") return { ok: false, value: ERR_INVALID_STATUS };
    if (escrow.disputeActive) return { ok: false, value: ERR_DISPUTE_ACTIVE };
    this.state.escrows.set(bookingId, { ...escrow, status: "released" });
    this.stxTransfers.push({ amount: escrow.amount, from: "contract", to: escrow.guide });
    return { ok: true, value: true };
  }

  refundPayment(bookingId: number): Result<boolean> {
    const escrow = this.state.escrows.get(bookingId);
    if (!escrow) return { ok: false, value: ERR_NO_DEPOSIT };
    if (this.caller !== escrow.traveler && this.caller !== this.state.admin) return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (escrow.status !== "deposited") return { ok: false, value: ERR_INVALID_STATUS };
    if (escrow.disputeActive) return { ok: false, value: ERR_DISPUTE_ACTIVE };
    this.state.escrows.set(bookingId, { ...escrow, status: "refunded" });
    this.stxTransfers.push({ amount: escrow.amount, from: "contract", to: escrow.traveler });
    return { ok: true, value: true };
  }

  flagDispute(bookingId: number): Result<boolean> {
    const escrow = this.state.escrows.get(bookingId);
    if (!escrow) return { ok: false, value: ERR_NO_DEPOSIT };
    if (this.caller !== escrow.traveler) return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (escrow.status !== "deposited") return { ok: false, value: ERR_INVALID_STATUS };
    if (escrow.disputeActive) return { ok: false, value: ERR_DISPUTE_ACTIVE };
    this.state.escrows.set(bookingId, { ...escrow, disputeActive: true });
    return { ok: true, value: true };
  }

  resolveDispute(bookingId: number, releaseToGuide: boolean): Result<boolean> {
    const escrow = this.state.escrows.get(bookingId);
    if (!escrow) return { ok: false, value: ERR_NO_DEPOSIT };
    if (this.caller !== this.state.admin) return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (!escrow.disputeActive) return { ok: false, value: ERR_DISPUTE_ACTIVE };
    if (escrow.status !== "deposited") return { ok: false, value: ERR_INVALID_STATUS };
    this.state.escrows.set(bookingId, {
      ...escrow,
      status: releaseToGuide ? "released" : "refunded",
      disputeActive: false,
    });
    this.stxTransfers.push({
      amount: escrow.amount,
      from: "contract",
      to: releaseToGuide ? escrow.guide : escrow.traveler,
    });
    return { ok: true, value: true };
  }
}

describe("Escrow Contract", () => {
  let contract: EscrowMock;

  beforeEach(() => {
    contract = new EscrowMock();
    contract.reset();
    contract.setBookingContract(1, "ST1BOOKING");
  });

  it("deposits payment successfully", async () => {
    const result = contract.depositPayment(1, 1000);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const escrow = contract.getEscrowDetails(1);
    expect(escrow?.traveler).toBe("ST1TRAVELER");
    expect(escrow?.guide).toBe("ST1GUIDE");
    expect(escrow?.amount).toBe(900);
    expect(escrow?.status).toBe("deposited");
    expect(escrow?.feeAmount).toBe(100);
    expect(contract.stxTransfers).toEqual([
      { amount: 100, from: "ST1TRAVELER", to: "ST1ADMIN" },
      { amount: 900, from: "ST1TRAVELER", to: "contract" },
    ]);
  });

  it("rejects deposit with invalid amount", async () => {
    const result = contract.depositPayment(1, 0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_AMOUNT);
  });

  it("rejects duplicate deposit", async () => {
    contract.depositPayment(1, 1000);
    const result = contract.depositPayment(1, 1000);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ALREADY_DEPOSITED);
  });

  it("releases payment successfully", async () => {
    contract.depositPayment(1, 1000);
    const result = contract.releasePayment(1);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const escrow = contract.getEscrowDetails(1);
    expect(escrow?.status).toBe("released");
    expect(contract.stxTransfers).toContainEqual({ amount: 900, from: "contract", to: "ST1GUIDE" });
  });

  it("rejects release by non-traveler", async () => {
    contract.depositPayment(1, 1000);
    contract.caller = "ST2FAKE";
    const result = contract.releasePayment(1);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("refunds payment successfully", async () => {
    contract.depositPayment(1, 1000);
    const result = contract.refundPayment(1);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const escrow = contract.getEscrowDetails(1);
    expect(escrow?.status).toBe("refunded");
    expect(contract.stxTransfers).toContainEqual({ amount: 900, from: "contract", to: "ST1TRAVELER" });
  });

  it("flags dispute successfully", async () => {
    contract.depositPayment(1, 1000);
    const result = contract.flagDispute(1);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const escrow = contract.getEscrowDetails(1);
    expect(escrow?.disputeActive).toBe(true);
  });

  it("resolves dispute successfully", async () => {
    contract.depositPayment(1, 1000);
    contract.flagDispute(1);
    contract.caller = "ST1ADMIN";
    const result = contract.resolveDispute(1, true);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const escrow = contract.getEscrowDetails(1);
    expect(escrow?.status).toBe("released");
    expect(escrow?.disputeActive).toBe(false);
    expect(contract.stxTransfers).toContainEqual({ amount: 900, from: "contract", to: "ST1GUIDE" });
  });

  it("sets platform fee successfully", async () => {
    contract.caller = "ST1ADMIN";
    const result = contract.setPlatformFee(200);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.getPlatformFee().value).toBe(200);
  });
});