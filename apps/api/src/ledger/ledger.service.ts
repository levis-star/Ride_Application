import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { LedgerAccount, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

export interface LedgerLine {
  account: LedgerAccount;
  driverId?: string;
  debit?: number;
  credit?: number;
  tripId?: string;
  paymentId?: string;
  memo?: string;
}

type Tx = Prisma.TransactionClient;

/**
 * The ONLY money write-path (spec §9): every movement is a balanced
 * transaction — entries per txnId sum to zero, enforced here before any row
 * is written. `DriverProfile.walletBalance` is a cache of the ledger and is
 * updated in the same database transaction; the nightly reconciliation
 * re-derives it from the ledger and flags drift.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  private validate(lines: LedgerLine[]): void {
    if (lines.length < 2) throw new BadRequestException("Ledger txn needs >= 2 lines");
    let debits = 0;
    let credits = 0;
    for (const line of lines) {
      const debit = line.debit ?? 0;
      const credit = line.credit ?? 0;
      if (!Number.isInteger(debit) || !Number.isInteger(credit) || debit < 0 || credit < 0) {
        throw new BadRequestException("Ledger amounts must be non-negative integers (TZS)");
      }
      if ((debit > 0) === (credit > 0)) {
        throw new BadRequestException("Each ledger line must have exactly one of debit/credit > 0");
      }
      if (line.account === LedgerAccount.DRIVER_WALLET && !line.driverId) {
        throw new BadRequestException("DRIVER_WALLET lines require driverId");
      }
      debits += debit;
      credits += credit;
    }
    if (debits !== credits) {
      throw new BadRequestException(`Unbalanced ledger txn: debits ${debits} != credits ${credits}`);
    }
  }

  /** Post inside an existing Prisma transaction. */
  async postWithinTx(tx: Tx, lines: LedgerLine[], txnId = randomUUID()): Promise<string> {
    this.validate(lines);
    await tx.ledgerEntry.createMany({
      data: lines.map((l) => ({
        txnId,
        account: l.account,
        driverId: l.driverId,
        debit: new Prisma.Decimal(l.debit ?? 0),
        credit: new Prisma.Decimal(l.credit ?? 0),
        tripId: l.tripId,
        paymentId: l.paymentId,
        memo: l.memo,
      })),
    });
    // Wallet cache: credits increase the driver balance, debits decrease it.
    for (const l of lines) {
      if (l.account !== LedgerAccount.DRIVER_WALLET) continue;
      const delta = (l.credit ?? 0) - (l.debit ?? 0);
      if (delta === 0) continue;
      await tx.driverProfile.update({
        where: { id: l.driverId! },
        data: { walletBalance: { increment: delta } },
      });
    }
    return txnId;
  }

  async postTransaction(lines: LedgerLine[]): Promise<string> {
    return this.prisma.$transaction((tx) => this.postWithinTx(tx, lines));
  }

  async driverBalanceFromLedger(driverId: string): Promise<number> {
    const agg = await this.prisma.ledgerEntry.aggregate({
      where: { driverId, account: LedgerAccount.DRIVER_WALLET },
      _sum: { debit: true, credit: true },
    });
    return Number(agg._sum.credit ?? 0) - Number(agg._sum.debit ?? 0);
  }

  /**
   * Reconciliation (spec §5/§9): global sum-zero check + wallet caches
   * re-derived from the ledger. Drift is corrected and logged to AuditLog for
   * the admin screen (phase 5). Returns a report.
   */
  async reconcile(): Promise<{ globalSum: number; driversChecked: number; driftFixed: number }> {
    const global = await this.prisma.ledgerEntry.aggregate({ _sum: { debit: true, credit: true } });
    const globalSum = Number(global._sum.debit ?? 0) - Number(global._sum.credit ?? 0);
    if (globalSum !== 0) {
      this.logger.error(`LEDGER OUT OF BALANCE: global debit-credit = ${globalSum}`);
      await this.prisma.auditLog.create({
        data: {
          actorId: "SYSTEM",
          action: "RECONCILIATION_GLOBAL_IMBALANCE",
          entity: "LedgerEntry",
          entityId: "*",
          after: { globalSum },
        },
      });
    }

    const drivers = await this.prisma.driverProfile.findMany({ select: { id: true, walletBalance: true } });
    let driftFixed = 0;
    for (const d of drivers) {
      const computed = await this.driverBalanceFromLedger(d.id);
      if (computed !== Number(d.walletBalance)) {
        driftFixed++;
        this.logger.warn(`Wallet drift driver ${d.id}: cache ${d.walletBalance} != ledger ${computed} — fixing`);
        await this.prisma.$transaction([
          this.prisma.driverProfile.update({
            where: { id: d.id },
            data: { walletBalance: new Prisma.Decimal(computed) },
          }),
          this.prisma.auditLog.create({
            data: {
              actorId: "SYSTEM",
              action: "RECONCILIATION_WALLET_DRIFT_FIXED",
              entity: "DriverProfile",
              entityId: d.id,
              before: { cache: Number(d.walletBalance) },
              after: { ledger: computed },
            },
          }),
        ]);
      }
    }
    return { globalSum, driversChecked: drivers.length, driftFixed };
  }
}
