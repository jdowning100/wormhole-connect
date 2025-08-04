import { CONFIG as LEGACY_CONFIG } from 'sdklegacy';
import MAINNET from './mainnet';
import TESTNET from './testnet';
import DEVNET from './devnet';
import type { WormholeConnectConfig } from './types';
import { InternalConfig } from './types';
import { mergeCustomWrappedTokens, validateDefaults } from './utils';
import { wrapEventHandler } from './events';
import { capitalize } from './utils';
import { deserialize } from '@wormhole-foundation/sdk-definitions';

export * from './types';

import {
  wormhole as getWormholeV2,
  Wormhole as WormholeV2,
  Network,
  Token as SDKToken,
  ChainTokens as SDKChainTokens,
  WormholeConfigOverrides as WormholeConfigOverridesV2,
  Chain,
} from '@wormhole-foundation/sdk';

import '@wormhole-foundation/sdk/addresses';
import evm from '@wormhole-foundation/sdk/evm';
import solana from '@wormhole-foundation/sdk/solana';
import aptos from '@wormhole-foundation/sdk/aptos';
import sui from '@wormhole-foundation/sdk/sui';
// Import NTT protocol implementations
import '@wormhole-foundation/sdk-definitions-ntt';
import '@wormhole-foundation/sdk-evm-ntt';
import '@wormhole-foundation/sdk-solana-ntt';
import RouteOperator from 'routes/operator';
import { CHAIN_ORDER } from './constants';
import { createUiConfig } from './ui';
import { buildTokenCache } from './tokens';
import { EvmAddress } from '@wormhole-foundation/sdk-evm';

export function buildConfig(
  customConfig: WormholeConnectConfig = {},
): InternalConfig<Network> {
  const network = capitalize(
    customConfig.network ||
      import.meta.env.REACT_APP_CONNECT_ENV?.toLowerCase() ||
      'Mainnet',
  ) as Network;

  if (!['Mainnet', 'Testnet', 'Devnet'].includes(network))
    throw new Error(
      `Invalid env "${network}": Use "Testnet", "Devnet", or "Mainnet"`,
    );

  const networkData = { MAINNET, DEVNET, TESTNET }[network.toUpperCase()]!;

  const wrappedTokens = mergeCustomWrappedTokens(
    networkData.wrappedTokens,
    customConfig.wrappedTokens,
  );

  const cacheKey = (name: string) => {
    if (customConfig.cacheNamespace) {
      return `wormhole-connect:${customConfig.cacheNamespace}:${name}`;
    } else {
      return `wormhole-connect:${name}`;
    }
  };

  const tokens = buildTokenCache(
    [
      ...networkData.tokens,
      ...(customConfig.tokensConfig
        ? Object.values(customConfig.tokensConfig)
        : []),
    ],
    wrappedTokens,
    cacheKey(`token-cache:${network}`),
  );

  const sdkConfig = LEGACY_CONFIG[network.toUpperCase()];

  const rpcs = Object.assign(
    {},
    sdkConfig.rpcs,
    networkData.rpcs,
    customConfig.rpcs,
  );

  if (customConfig.ui?.defaultInputs) {
    validateDefaults(customConfig.ui.defaultInputs, networkData.chains, tokens);
  }

  const ui = createUiConfig(customConfig.ui ?? {});

  if (
    customConfig.tokens &&
    customConfig.tokens.length > 0 &&
    ui.disableUserInputtedTokens === undefined
  ) {
    // If the integrator has provided a whitelist of tokens, we can reasonably assume they also don't want
    // users pasting in arbitrary token addresses.
    ui.disableUserInputtedTokens = true;
  }

  return {
    sdkConfig,

    network,
    isMainnet: network === 'Mainnet',

    // External resources
    rpcs,
    evmIndexers: customConfig.evmIndexers,
    mayanApi: 'https://explorer-api.mayan.finance',
    wormholeApi: {
      Mainnet: 'https://api.wormholescan.io/',
      Testnet: 'https://api.testnet.wormholescan.io/',
      Devnet: '',
    }[network],
    wormholeRpcHosts: {
      Mainnet: [
        'https://wormhole-v2-mainnet-api.mcf.rocks',
        'https://wormhole-v2-mainnet-api.chainlayer.network',
        'https://wormhole-v2-mainnet-api.staking.fund',
      ],
      Testnet: [
        'https://guardian.testnet.xlabs.xyz',
        'https://guardian-01.testnet.xlabs.xyz',
        'https://guardian-02.testnet.xlabs.xyz',
      ],
      Devnet: ['http://localhost:7071'],
    }[network],
    coingecko: customConfig.coingecko,

    // Callbacks
    triggerEvent: wrapEventHandler(customConfig.eventHandler),
    validateTransfer: customConfig.validateTransferHandler,
    isRouteSupportedHandler: customConfig.isRouteSupportedHandler,
    isTokenSupportedHandler: customConfig.isTokenSupportedHandler,
    filterRoutes: customConfig.filterRoutes,

    // White lists
    chains: networkData.chains,
    chainsArr: Object.values(networkData.chains)
      .filter((chain) => {
        return customConfig.chains
          ? customConfig.chains.includes(chain.sdkName)
          : true;
      })
      .sort((a, b) => {
        const ai = CHAIN_ORDER.indexOf(a.sdkName);
        const bi = CHAIN_ORDER.indexOf(b.sdkName);
        if (ai >= 0 && bi >= 0) return ai - bi;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return 0;
      }),
    tokens,
    tokenWhitelist: customConfig.tokens,

    routes: new RouteOperator(customConfig.routes),

    // UI details
    ui: createUiConfig({ ...customConfig.ui }),

    // Used to namespace localStorage caches
    cacheKey,

    // Guardian Set
    guardianSet: networkData.guardianSet,

    // Transaction settings
    transactionSettings: customConfig?.transactionSettings || {},
  };
}

// Running buildConfig with no argument generates the default configuration
const config = buildConfig();
export default config;

export async function getWormholeContextV2(): Promise<WormholeV2<Network>> {
  if (config._v2Wormhole) return config._v2Wormhole;
  config._v2Wormhole = await newWormholeContextV2();
  return config._v2Wormhole;
}

// To be used when something changes, like a new token being added which should be in the token map
export async function clearWormholeContextV2() {
  delete config._v2Wormhole;
}

export async function newWormholeContextV2(): Promise<WormholeV2<Network>> {
  const v2Config: WormholeConfigOverridesV2<Network> = { chains: {} };

  for (const key in config.chains) {
    const chain = key as Chain;
    const rpc = config.rpcs[chain];
    const tokenMap: SDKChainTokens = {};

    for (const token of config.tokens.getAllForChain(chain)) {
      const sdkToken: Partial<SDKToken> = {
        key: token.key,
        chain: chain,
        symbol: token.symbol,
        address: token.address.toString(),
        decimals: token.decimals,
      };

      tokenMap[token.address.toString()] = sdkToken as SDKToken;
    }

    v2Config.chains![chain] = { rpc, tokenMap };
  }

  const wormhole = await getWormholeV2(
    config.network,
    [evm, solana, aptos, sui],
    v2Config,
  );

  // Override getVaaBytes method for QuaiTestnet
  const originalGetVaaBytes = wormhole.getVaaBytes.bind(wormhole);
  wormhole.getVaaBytes = async function (wormholeMessageId, timeout) {
    if (wormholeMessageId.chain === 'QuaiTestnet') {
      // Use local guardian for QuaiTestnet
      const localGuardianUrl = 'http://localhost:7071';
      const emitterAddress = wormholeMessageId.emitter
        .toString()
        .replace('0x', '');
      const url = `${localGuardianUrl}/v1/signed_vaa/15000/${emitterAddress}/${wormholeMessageId.sequence}`;

      // Poll for VAA for up to 60 seconds
      const maxAttempts = 60;
      const delayMs = 1000; // 1 second between attempts
      
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const response = await fetch(url);
          if (response.ok) {
            const data = await response.json();
            // Convert base64 to Uint8Array
            const base64 = data.vaaBytes;
            const binaryString = atob(base64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes;
          } else if (response.status === 404) {
            // VAA not found yet, wait and retry
            console.log(`QuaiTestnet VAA not found yet, attempt ${attempt + 1}/${maxAttempts}`);
            if (attempt < maxAttempts - 1) {
              await new Promise(resolve => setTimeout(resolve, delayMs));
              continue;
            }
          } else {
            // Non-404 error, don't retry
            console.error(`Error fetching VAA from local guardian: ${response.status}`);
            break;
          }
        } catch (error) {
          console.error('Error fetching VAA from local guardian:', error);
          // Network error, wait and retry
          if (attempt < maxAttempts - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
            continue;
          }
        }
      }
      
      // If we exhausted all attempts, return null
      console.error('Failed to fetch QuaiTestnet VAA after 60 seconds');
      return null;
    }

    // Fall back to original method for other chains
    return originalGetVaaBytes(wormholeMessageId, timeout);
  };

  // Override getVaa method as well
  const originalGetVaa = wormhole.getVaa.bind(wormhole);
  wormhole.getVaa = async function (id, decodeAs, timeout) {
    // Handle both WormholeMessageId and transaction hash
    if (typeof id === 'string') {
      // This is a transaction hash - check if it's from QuaiTestnet
      // by fetching the receipt and looking for Wormhole events
      console.log('getVaa called with tx hash:', id);
      
      try {
        // Get QuaiTestnet RPC
        const quaiRpc = config.rpcs['QuaiTestnet'];
        if (quaiRpc) {
          const response = await fetch(quaiRpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'eth_getTransactionReceipt',
              params: [id],
              id: 1,
            }),
          });
          
          const result = await response.json();
          if (result.result && result.result.logs) {
            // Look for LogMessagePublished event (topic: 0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2)
            for (const log of result.result.logs) {
              if (log.topics[0] === '0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2') {
                // Extract emitter and sequence from the log
                const emitter = '0x' + log.topics[1].slice(26); // Remove padding
                const sequence = parseInt(log.data.slice(2, 66), 16);
                
                console.log('Found QuaiTestnet LogMessagePublished:', { emitter, sequence });
                

                const emitterEvmAddress = new EvmAddress(emitter);
                
                const messageId = {
                  chain: 'QuaiTestnet' as const,
                  emitter: emitterEvmAddress.toUniversalAddress(),
                  sequence: BigInt(sequence),
                };
                
                const vaaBytes = await wormhole.getVaaBytes(messageId, timeout);
                if (vaaBytes) {
                  try {
                    return deserialize(decodeAs, vaaBytes);
                  } catch (error) {
                    console.error('Error deserializing VAA:', error);
                    console.log('VAA bytes:', vaaBytes);
                    console.log('Decode as:', decodeAs);
                    throw error;
                  }
                }
              }
            }
          }
        }
      } catch (error) {
        console.log('Error fetching QuaiTestnet receipt:', error);
      }
    } else if (id.chain === 'QuaiTestnet') {
      // This is a WormholeMessageId
      const vaaBytes = await wormhole.getVaaBytes(id, timeout);
      if (vaaBytes) {
        return deserialize(decodeAs, vaaBytes);
      }
      return null;
    }

    // Fall back to original method for other chains or tx hash
    return originalGetVaa(id, decodeAs, timeout);
  };

  return wormhole;
}

// setConfig can be called afterwards to override the default config with integrator-provided config

export function setConfig(customConfig: WormholeConnectConfig = {}) {
  const newConfig: InternalConfig<Network> = buildConfig(customConfig);

  // We overwrite keys in the existing object so the references to the config
  // imported elsewhere point to the new values
  for (const key in newConfig) {
    /* @ts-ignore */
    config[key] = newConfig[key];
  }
  if (typeof window !== 'undefined') {
    /* @ts-ignore */
    window._connectConfig = config;
  }
}

// TODO: add config validation step to buildConfig
//validateConfigs();
