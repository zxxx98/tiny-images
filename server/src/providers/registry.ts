import { UpstreamError } from "../core/errors.js";
import type { ChannelType, ImageProvider } from "../core/types.js";
import { AIHordeProvider } from "./ai-horde.js";
import { OpenAICompatProvider } from "./openai-compat.js";

export type ProviderRegistry = ReadonlyMap<string, ImageProvider>;

export function providerFor(registry: ProviderRegistry, type: ChannelType | string): ImageProvider {
  const provider = registry.get(type);
  if (!provider) {
    throw new UpstreamError(500, "configuration_error", `no provider registered for channel type '${type}'`);
  }
  return provider;
}

export function createProviderRegistry(...providers: ImageProvider[]): ProviderRegistry {
  return new Map(providers.map((provider) => [provider.kind, provider]));
}

export function createDefaultProviderRegistry(): ProviderRegistry {
  return createProviderRegistry(new OpenAICompatProvider(), new AIHordeProvider());
}
