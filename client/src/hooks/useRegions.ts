import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import { ApiRequestError } from '../api/client';
import type { CreateRegionInput, Region, UpdateRegionInput } from '../types';

export interface UseRegionsReturn {
  regions: Region[];
  loading: boolean;
  error: string | null;
  create: (input: CreateRegionInput) => Promise<Region | null>;
  update: (regionId: string, updates: UpdateRegionInput) => Promise<Region | null>;
  remove: (regionId: string) => Promise<boolean>;
  refresh: () => void;
  clearError: () => void;
}

/**
 * Region CRUD for one document, with the list kept in local state.
 *
 * Moves and resizes apply optimistically so dragging stays smooth, and roll
 * back to the previous rectangle if the server rejects the change. Creates and
 * deletes wait for the server, since both need its answer: the new id in one
 * case, and confirmation the row is gone in the other.
 */
export function useRegions(documentId: string | null): UseRegionsReturn {
  const [regions, setRegions] = useState<Region[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!documentId) {
      setRegions([]);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    api
      .listRegions(documentId, undefined, controller.signal)
      .then((loaded) => {
        if (mountedRef.current) setRegions(loaded);
      })
      .catch((caught: unknown) => {
        if (caught instanceof ApiRequestError && caught.code === 'CANCELLED') return;
        if (mountedRef.current) {
          setError(caught instanceof Error ? caught.message : 'Could not load regions');
        }
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false);
      });

    return () => controller.abort();
  }, [documentId, reloadToken]);

  const describe = (caught: unknown, fallback: string): string =>
    caught instanceof Error ? caught.message : fallback;

  const create = useCallback(
    async (input: CreateRegionInput): Promise<Region | null> => {
      if (!documentId) return null;
      try {
        const created = await api.createRegion(documentId, input);
        if (mountedRef.current) {
          setRegions((current) => [...current, created]);
          setError(null);
        }
        return created;
      } catch (caught) {
        if (mountedRef.current) setError(describe(caught, 'Could not create the region'));
        return null;
      }
    },
    [documentId],
  );

  const update = useCallback(
    async (regionId: string, updates: UpdateRegionInput): Promise<Region | null> => {
      if (!documentId) return null;

      let previous: Region | undefined;
      setRegions((current) => {
        previous = current.find((region) => region.id === regionId);
        return current.map((region) =>
          region.id === regionId ? { ...region, ...updates } : region,
        );
      });

      try {
        const saved = await api.updateRegion(documentId, regionId, updates);
        if (mountedRef.current) {
          setRegions((current) =>
            current.map((region) => (region.id === regionId ? saved : region)),
          );
          setError(null);
        }
        return saved;
      } catch (caught) {
        // Put the old rectangle back so the canvas matches the server.
        if (mountedRef.current) {
          const restore = previous;
          if (restore) {
            setRegions((current) =>
              current.map((region) => (region.id === regionId ? restore : region)),
            );
          }
          setError(describe(caught, 'Could not update the region'));
        }
        return null;
      }
    },
    [documentId],
  );

  const remove = useCallback(
    async (regionId: string): Promise<boolean> => {
      if (!documentId) return false;
      try {
        await api.deleteRegion(documentId, regionId);
        if (mountedRef.current) {
          setRegions((current) => current.filter((region) => region.id !== regionId));
          setError(null);
        }
        return true;
      } catch (caught) {
        if (mountedRef.current) setError(describe(caught, 'Could not delete the region'));
        return false;
      }
    },
    [documentId],
  );

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);
  const clearError = useCallback(() => setError(null), []);

  return { regions, loading, error, create, update, remove, refresh, clearError };
}
