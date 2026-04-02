import type { ProviderMetadata } from './provider';
import { providerMetadata as openai } from './openai';
import { providerMetadata as azureOpenai } from './azure-openai';
import { providerMetadata as anthropic } from './anthropic';

/** All registered LLM providers. To add a new provider, import its metadata here. */
export const PROVIDERS: ProviderMetadata[] = [openai, azureOpenai, anthropic];
