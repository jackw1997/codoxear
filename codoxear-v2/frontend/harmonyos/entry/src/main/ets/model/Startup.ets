@Observed
export class Startup {
  error: string = 'Unlock this device to access your Hub accounts.';
  retry: () => Promise<void> = async () => {};
}
