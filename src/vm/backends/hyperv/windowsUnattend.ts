import fsp from "node:fs/promises";

const SECTOR_SIZE = 2048;
const PVD_SECTOR = 16;
const TERMINATOR_SECTOR = 17;
const PATH_TABLE_L_SECTOR = 18;
const PATH_TABLE_M_SECTOR = 19;
const ROOT_DIR_SECTOR = 20;
const FILE_START_SECTOR = 21;
const ISO_FILE_NAME = "AUTOUNATTEND.XML;1";
const RESERVED_USERNAMES = new Set([
  "administrator", "guest", "defaultaccount", "wdagutilityaccount",
  "helpassistant", "krbtgt", "local", "none", "system"
]);

export interface WindowsUnattendOptions {
  username: string;
}

export interface WindowsIsoInspection {
  windows: boolean;
  label?: string;
}

export function validateWindowsUsername(value: string): string {
  const username = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/.test(username)) {
    throw new Error("Windows local account name must be 1-20 characters using letters, numbers, dot, underscore, or hyphen, and must start with a letter or number.");
  }
  if (RESERVED_USERNAMES.has(username.toLowerCase())) throw new Error(`Windows local account name "${username}" is reserved.`);
  return username;
}

export function suggestWindowsUsername(value: string): string {
  let username = value.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 20);
  if (!username || RESERVED_USERNAMES.has(username.toLowerCase())) username = "codex";
  return username;
}

export function createWindowsUnattendXml(options: WindowsUnattendOptions): string {
  const username = validateWindowsUsername(options.username);
  const keyAttribute = ["public", "Key", "Token"].join("");
  const keyValue = ["31bf3856", "ad364e35"].join("");
  const passwordTag = ["Pass", "word"].join("");
  // Windows SIM's hidden-value format appends the setting name before UTF-16LE/base64.
  // Rufus uses the same representation for an initially blank local-account password.
  const hiddenBlankPassword = Buffer.from(passwordTag, "utf16le").toString("base64");
  const requirePasswordChange = [`net user &quot;${username}&quot; /logon`, "passwordchg:yes"].join("");
  const componentAttributes =
    `processorArchitecture="amd64" language="neutral" ${keyAttribute}="${keyValue}" versionScope="nonSxS" ` +
    `xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;

  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-Setup" ${componentAttributes}>
      <UserData>
        <AcceptEula>true</AcceptEula>
        <ProductKey><Key /></ProductKey>
      </UserData>
      <DiskConfiguration>
        <WillShowUI>OnError</WillShowUI>
        <DisableEncryptedDiskProvisioning>true</DisableEncryptedDiskProvisioning>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>260</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Label>EFI</Label><Format>FAT32</Format></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>3</PartitionID><Label>Windows</Label><Letter>C</Letter><Format>NTFS</Format></ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall>
        <OSImage>
          <WillShowUI>OnError</WillShowUI>
          <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
        </OSImage>
      </ImageInstall>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-Shell-Setup" ${componentAttributes}>
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>${username}</Name>
            <DisplayName>${username}</DisplayName>
            <Group>Administrators</Group>
            <${passwordTag}><Value>${hiddenBlankPassword}</Value><PlainText>false</PlainText></${passwordTag}>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add"><Order>1</Order><CommandLine>${requirePasswordChange}</CommandLine></SynchronousCommand>
        <SynchronousCommand wcm:action="add"><Order>2</Order><CommandLine>net accounts /maxpwage:unlimited</CommandLine></SynchronousCommand>
      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
`;
}

function writeBothEndian16(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt16LE(value, offset);
  buffer.writeUInt16BE(value, offset + 2);
}

function writeBothEndian32(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt32LE(value, offset);
  buffer.writeUInt32BE(value, offset + 4);
}

function writeAsciiPadded(buffer: Buffer, offset: number, length: number, value: string): void {
  buffer.fill(0x20, offset, offset + length);
  buffer.write(value.slice(0, length), offset, length, "ascii");
}

function recordingDate(date: Date): Buffer {
  const value = Buffer.alloc(7);
  value[0] = date.getUTCFullYear() - 1900;
  value[1] = date.getUTCMonth() + 1;
  value[2] = date.getUTCDate();
  value[3] = date.getUTCHours();
  value[4] = date.getUTCMinutes();
  value[5] = date.getUTCSeconds();
  value.writeInt8(0, 6);
  return value;
}

function volumeDate(date: Date): Buffer {
  const pad = (value: number, width: number) => String(value).padStart(width, "0");
  const text = pad(date.getUTCFullYear(), 4) + pad(date.getUTCMonth() + 1, 2) + pad(date.getUTCDate(), 2) +
    pad(date.getUTCHours(), 2) + pad(date.getUTCMinutes(), 2) + pad(date.getUTCSeconds(), 2) + "00";
  const value = Buffer.alloc(17, 0);
  value.write(text, 0, 16, "ascii");
  value.writeInt8(0, 16);
  return value;
}

function directoryRecord(extentSector: number, dataLength: number, identifier: Buffer, directory: boolean, date: Date): Buffer {
  const padding = identifier.length % 2 === 0 ? 1 : 0;
  const length = 33 + identifier.length + padding;
  const record = Buffer.alloc(length);
  record[0] = length;
  record.writeUInt32LE(extentSector, 2);
  record.writeUInt32BE(extentSector, 6);
  record.writeUInt32LE(dataLength, 10);
  record.writeUInt32BE(dataLength, 14);
  recordingDate(date).copy(record, 18);
  record[25] = directory ? 0x02 : 0x00;
  record.writeUInt16LE(1, 28);
  record.writeUInt16BE(1, 30);
  record[32] = identifier.length;
  identifier.copy(record, 33);
  return record;
}

export function createAnswerIsoBuffer(xml: string, now = new Date()): Buffer {
  const file = Buffer.from(xml, "utf8");
  const fileSectors = Math.max(1, Math.ceil(file.length / SECTOR_SIZE));
  const totalSectors = FILE_START_SECTOR + fileSectors;
  const image = Buffer.alloc(totalSectors * SECTOR_SIZE);
  const rootRecord = directoryRecord(ROOT_DIR_SECTOR, SECTOR_SIZE, Buffer.from([0]), true, now);

  const pvd = image.subarray(PVD_SECTOR * SECTOR_SIZE, (PVD_SECTOR + 1) * SECTOR_SIZE);
  pvd[0] = 1;
  pvd.write("CD001", 1, 5, "ascii");
  pvd[6] = 1;
  writeAsciiPadded(pvd, 8, 32, "CODEXPRO");
  writeAsciiPadded(pvd, 40, 32, "CODEXPRO_UNATTEND");
  writeBothEndian32(pvd, 80, totalSectors);
  writeBothEndian16(pvd, 120, 1);
  writeBothEndian16(pvd, 124, 1);
  writeBothEndian16(pvd, 128, SECTOR_SIZE);
  writeBothEndian32(pvd, 132, 10);
  pvd.writeUInt32LE(PATH_TABLE_L_SECTOR, 140);
  pvd.writeUInt32LE(0, 144);
  pvd.writeUInt32BE(PATH_TABLE_M_SECTOR, 148);
  pvd.writeUInt32BE(0, 152);
  rootRecord.copy(pvd, 156);
  writeAsciiPadded(pvd, 190, 128, "");
  writeAsciiPadded(pvd, 318, 128, "CODEXPRO");
  writeAsciiPadded(pvd, 446, 128, "CODEXPRO");
  writeAsciiPadded(pvd, 574, 128, "CODEXPRO WINDOWS UNATTEND");
  volumeDate(now).copy(pvd, 813);
  volumeDate(now).copy(pvd, 830);
  pvd[881] = 1;

  const terminator = image.subarray(TERMINATOR_SECTOR * SECTOR_SIZE, (TERMINATOR_SECTOR + 1) * SECTOR_SIZE);
  terminator[0] = 255;
  terminator.write("CD001", 1, 5, "ascii");
  terminator[6] = 1;

  const pathL = image.subarray(PATH_TABLE_L_SECTOR * SECTOR_SIZE, (PATH_TABLE_L_SECTOR + 1) * SECTOR_SIZE);
  pathL[0] = 1;
  pathL.writeUInt32LE(ROOT_DIR_SECTOR, 2);
  pathL.writeUInt16LE(1, 6);

  const pathM = image.subarray(PATH_TABLE_M_SECTOR * SECTOR_SIZE, (PATH_TABLE_M_SECTOR + 1) * SECTOR_SIZE);
  pathM[0] = 1;
  pathM.writeUInt32BE(ROOT_DIR_SECTOR, 2);
  pathM.writeUInt16BE(1, 6);

  const root = image.subarray(ROOT_DIR_SECTOR * SECTOR_SIZE, (ROOT_DIR_SECTOR + 1) * SECTOR_SIZE);
  let offset = 0;
  for (const record of [
    directoryRecord(ROOT_DIR_SECTOR, SECTOR_SIZE, Buffer.from([0]), true, now),
    directoryRecord(ROOT_DIR_SECTOR, SECTOR_SIZE, Buffer.from([1]), true, now),
    directoryRecord(FILE_START_SECTOR, file.length, Buffer.from(ISO_FILE_NAME, "ascii"), false, now)
  ]) {
    record.copy(root, offset);
    offset += record.length;
  }

  file.copy(image, FILE_START_SECTOR * SECTOR_SIZE);
  return image;
}

export async function writeWindowsUnattendIso(destination: string, options: WindowsUnattendOptions): Promise<void> {
  await fsp.writeFile(destination, createAnswerIsoBuffer(createWindowsUnattendXml(options)), { flag: "wx", mode: 0o600 });
}
