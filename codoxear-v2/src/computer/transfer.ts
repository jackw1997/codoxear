import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { z } from "zod";
import { Attachment, readAttachment } from "./config.js";
import { normalizePairingCode } from "../contracts/pairing.js";

const Receipt = z.object({
  version: z.literal(1),
  hubUrl: z.url(),
  hubId: z.string(),
  computerId: z.string(),
  binding: z.number().int().positive(),
  transferId: z.string(),
});
const Detachment = z.object({
  detached: z.literal(true),
  transferId: z.string(),
  computerId: z.string(),
  hubId: z.string(),
  priorBinding: z.number().int().positive(),
  binding: z.number().int().positive(),
});
const Journal = z.object({
  version: z.literal(1),
  transferId: z.string(),
  source: Attachment,
  destinationHub: z.url(),
  code: z.string(),
  credential: z.string(),
  validated: z.boolean().default(false),
  detached: Detachment.optional(),
  admitted: Receipt.optional(),
});

/** Each local transition is fsynced before its external mutation. Source
 * detachment precedes destination admission; retry is bound to the same nonce
 * and generated destination credential, with no prompt/queue replay. */
async function durableJson(path: string, value: unknown) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID() + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const folder = await open(directory, "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}
function origin(value: string) {
  const url = new URL(value);
  if (
    url.origin !== value ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ))
  )
    throw Error("Transfer requires an exact HTTPS Hub origin");
  return value;
}
export async function transferComputer(
  home: string,
  input: { hub: string; code: string },
  transport: typeof fetch = fetch,
) {
  const destinationHub = origin(input.hub),
    code = normalizePairingCode(
      z.string().trim().min(8).max(100).parse(input.code),
    );
  const journalPath = join(home, "transfer.json");
  let createdJournal = false;
  let journal: z.infer<typeof Journal> | undefined;
  try {
    journal = Journal.parse(JSON.parse(await readFile(journalPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (journal) {
    if (journal.destinationHub !== destinationHub)
      throw Error(
        "Finish the saved transfer before choosing a different destination Hub",
      );
    if (journal.code !== code && !journal.admitted) {
      journal.code = code;
      if (!journal.detached) journal.validated = false;
      await durableJson(journalPath, journal);
    }
  } else {
    const source = await readAttachment(home);
    if (!source) throw Error("Attach this Computer before transferring it");
    if (source.hubUrl === destinationHub) {
      const completed = (await readFile(
        join(home, "transfer-receipt.json"),
        "utf8",
      )
        .then((value) => JSON.parse(value))
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        })) as {
        destination?: {
          hubUrl?: string;
          computerId?: string;
          binding?: number;
        };
      } | null;
      if (
        completed?.destination?.hubUrl === destinationHub &&
        completed.destination.computerId === source.computerId &&
        completed.destination.binding === source.binding
      )
        return completed;
      throw Error("Computer is already attached to this Hub");
    }
    journal = {
      version: 1,
      transferId: randomUUID(),
      source,
      destinationHub,
      code,
      credential: randomBytes(48).toString("base64url"),
      validated: false,
    };
    await durableJson(journalPath, journal);
    createdJournal = true;
  }
  const post = async (
    hub: string,
    path: string,
    body: unknown,
    credential?: string,
  ) => {
    const response = await transport(new URL(path, hub), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(
        `Transfer step rejected (${response.status}); the saved transfer can be retried with a current owner-issued admission code`,
      );
    }
    return response.json();
  };
  if (!journal.detached) {
    // Validate the destination owner-issued admission before relinquishing
    // source access. A concurrently revoked admission remains a retryable hold.
    if (!journal.validated) {
      try {
        const inspected = (await post(
          destinationHub,
          "/api/v1/pairing/inspect-transfer",
          { code: journal.code },
        )) as { hubUrl: string };
        if (inspected.hubUrl !== destinationHub)
          throw Error("Admission belongs to another Hub origin");
      } catch (error) {
        // No source mutation occurred. An invalid initial admission must leave
        // the current source attachment usable rather than create a false hold.
        if (createdJournal) await unlink(journalPath);
        throw error;
      }
      journal.validated = true;
      await durableJson(journalPath, journal);
    }
    const receipt = Detachment.parse(
      await post(
        journal.source.hubUrl,
        `/connect/v1/computers/${encodeURIComponent(journal.source.computerId)}/detach`,
        { transferId: journal.transferId },
        journal.source.credential,
      ),
    );
    if (
      receipt.transferId !== journal.transferId ||
      receipt.computerId !== journal.source.computerId ||
      receipt.hubId !== journal.source.hubId
    )
      throw Error("Source detachment receipt belongs to another Computer");
    journal.detached = receipt;
    await durableJson(journalPath, journal);
  }
  if (!journal.admitted) {
    const receipt = Receipt.parse(
      await post(destinationHub, "/api/v1/pairing/redeem-transfer", {
        code: journal.code,
        transferId: journal.transferId,
        credential: journal.credential,
      }),
    );
    if (
      receipt.transferId !== journal.transferId ||
      receipt.hubUrl !== destinationHub
    )
      throw Error("Destination admission receipt belongs to another transfer");
    journal.admitted = receipt;
    await durableJson(journalPath, journal);
  }
  const config = Attachment.parse({
    ...journal.source,
    ...journal.admitted,
    credential: journal.credential,
  });
  await durableJson(join(home, "attachment.json"), config);
  const result = {
    transferred: true,
    transferId: journal.transferId,
    source: journal.detached,
    destination: journal.admitted,
    runtime: config.runtime,
    message:
      "Start the Computer service, then explicitly import the retained native sessions at the destination Hub. Retained source queues require local review.",
  };
  await durableJson(join(home, "transfer-receipt.json"), result);
  await unlink(journalPath);
  const folder = await open(home, "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
  return result;
}
export async function transferStatus(home: string) {
  try {
    const journal = Journal.parse(
      JSON.parse(await readFile(join(home, "transfer.json"), "utf8")),
    );
    return {
      transferId: journal.transferId,
      destinationHub: journal.destinationHub,
      phase: journal.admitted
        ? "destination-admitted"
        : journal.detached
          ? "source-detached"
          : "prepared",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
