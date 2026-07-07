const DEFAULT_EXPLORER_BASE_URL = 'https://sepolia.etherscan.io';

export function explorerAddressUrl(address: string): string {
  const baseUrl = (import.meta.env.VITE_CHAIN_EXPLORER_BASE_URL || DEFAULT_EXPLORER_BASE_URL).replace(/\/+$/, '');
  return `${baseUrl}/address/${address}`;
}
