import { VmManager, publicVmImage, publicVmInstance, redactVmHostPaths } from "./vmManager.js";
import { VM_GUEST_FILE_MAX_BYTES, type VmExecOptions, type VmGuestCredential, type VmGuestShell } from "./guestControl.js";

export type VmToolAction = "images" | "create" | "status" | "destroy";

export interface VmToolArgs {
  action: VmToolAction;
  image?: string;
  id?: string;
  cpus?: number;
  memoryMb?: number;
}

export interface VmGuestStatusToolArgs {
  id: string;
  credential?: VmGuestCredential;
}

export interface VmExecToolArgs {
  id: string;
  argv?: string[];
  command?: string;
  shell?: VmGuestShell;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  credential?: VmGuestCredential;
}

export interface VmUploadToolArgs {
  id: string;
  guestPath: string;
  dataBase64: string;
  credential?: VmGuestCredential;
}

export interface VmDownloadToolArgs {
  id: string;
  guestPath: string;
  credential?: VmGuestCredential;
}

function withVmError<T>(manager: VmManager, action: () => Promise<T>): Promise<T> {
  return action().catch((error) => {
    throw new Error(redactVmHostPaths(error, undefined, manager.vmHome()));
  });
}

function decodeBase64(value: string): Buffer {
  if (typeof value !== "string") throw new Error("data_base64 must be a string.");
  if (value.length > Math.ceil(VM_GUEST_FILE_MAX_BYTES / 3) * 4) {
    throw new Error(`VM guest file transfer is limited to ${VM_GUEST_FILE_MAX_BYTES} bytes per file.`);
  }
  if (value !== "" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("data_base64 must be canonical standard base64.");
  }
  const data = Buffer.from(value, "base64");
  if (data.length > VM_GUEST_FILE_MAX_BYTES || data.toString("base64") !== value) {
    throw new Error("data_base64 is invalid or exceeds the VM guest file transfer limit.");
  }
  return data;
}

export async function runVmToolAction(
  args: VmToolArgs,
  manager = new VmManager()
): Promise<Record<string, unknown>> {
  return withVmError(manager, async () => {
    if (args.action === "images") {
      const images = (await manager.listImages()).map(publicVmImage);
      return { action: "images", images, imageCount: images.length };
    }
    if (args.action === "create") {
      if (!args.image) throw new Error("image is required for vm action=create.");
      const instance = await manager.createInstance(args.image, {
        cpus: args.cpus,
        memoryMb: args.memoryMb
      });
      return { action: "create", instance: publicVmInstance(instance) };
    }
    if (args.action === "status") {
      if (!args.id) throw new Error("id is required for vm action=status.");
      return { action: "status", instance: publicVmInstance(await manager.status(args.id)) };
    }
    if (args.action === "destroy") {
      if (!args.id) throw new Error("id is required for vm action=destroy.");
      await manager.destroyInstance(args.id);
      return { action: "destroy", id: args.id, state: "destroyed" };
    }
    throw new Error("Unsupported VM action.");
  });
}

export function runVmGuestStatusTool(
  args: VmGuestStatusToolArgs,
  manager = new VmManager()
): Promise<Record<string, unknown>> {
  return withVmError(manager, async () => ({
    action: "guest_status",
    guest: await manager.guestStatus(args.id, args.credential)
  }));
}

export function runVmExecTool(
  args: VmExecToolArgs,
  manager = new VmManager()
): Promise<Record<string, unknown>> {
  return withVmError(manager, async () => {
    const options: VmExecOptions = {
      argv: args.argv,
      command: args.command,
      shell: args.shell,
      cwd: args.cwd,
      env: args.env,
      timeoutMs: args.timeoutMs,
      credential: args.credential
    };
    const result = await manager.exec(args.id, options);
    return { action: "exec", id: args.id, ...result };
  });
}

export function runVmUploadTool(
  args: VmUploadToolArgs,
  manager = new VmManager()
): Promise<Record<string, unknown>> {
  return withVmError(manager, async () => {
    const data = decodeBase64(args.dataBase64);
    const result = await manager.upload(args.id, args.guestPath, data, args.credential);
    return { action: "upload", id: args.id, guestPath: args.guestPath, bytes: result.bytes };
  });
}

export function runVmDownloadTool(
  args: VmDownloadToolArgs,
  manager = new VmManager()
): Promise<Record<string, unknown>> {
  return withVmError(manager, async () => {
    const data = await manager.download(args.id, args.guestPath, args.credential);
    if (data.length > VM_GUEST_FILE_MAX_BYTES) throw new Error("Downloaded VM guest file exceeds the transfer limit.");
    return {
      action: "download",
      id: args.id,
      guestPath: args.guestPath,
      bytes: data.length,
      dataBase64: data.toString("base64")
    };
  });
}
