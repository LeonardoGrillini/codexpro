import type { CreateVmOptions, SetupVmImageOptions, VmDoctorReport } from "../api.js";
import type { VmArchitecture, VmImageManifest, VmInstanceRecord } from "../types.js";
import type { VmExecOptions, VmExecResult, VmGuestCredential, VmGuestStatus } from "../guestControl.js";

/** Backend boundary for lifecycle plus normalized guest control. */
export interface VmBackend {
  doctor(architecture?: VmArchitecture): Promise<VmDoctorReport>;
  setupImage(options: SetupVmImageOptions): Promise<VmImageManifest>;
  createInstance(image: string, options?: CreateVmOptions): Promise<VmInstanceRecord>;
  status(id: string): Promise<VmInstanceRecord>;
  listInstances(): Promise<VmInstanceRecord[]>;
  destroyInstance(id: string): Promise<void>;
  validateImage(name: string): Promise<VmImageManifest>;
  guestStatus(id: string, credential?: VmGuestCredential): Promise<VmGuestStatus>;
  exec(id: string, options: VmExecOptions): Promise<VmExecResult>;
  upload(id: string, guestPath: string, data: Buffer, credential?: VmGuestCredential): Promise<{ bytes: number }>;
  download(id: string, guestPath: string, credential?: VmGuestCredential): Promise<Buffer>;
}

export interface DiskImporter {
  backend: "qemu" | "hyperv";
  format: "qcow2" | "vhdx";
  prepare(source: string, destination: string): Promise<number>;
}
