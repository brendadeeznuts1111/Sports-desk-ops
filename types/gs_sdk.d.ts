/**
 * Type declarations for @ganchrowsci/gs-sdk used by feed team logo probing.
 */
declare module "@ganchrowsci/gs-sdk" {
  export interface GsSdkInstance {
    addEventListener(event: string, callback: (payload: unknown) => void): void;
    connect(): Promise<void>;
    close(): void;
  }

  export interface GsSdkConstructor {
    new (options: {
      url: string;
      username?: string;
      password?: string;
    }): GsSdkInstance;
  }

  export const GsSdk: GsSdkConstructor;
  export const ValidKinds: {
    readonly events: string;
    readonly [key: string]: string | undefined;
  };
}
