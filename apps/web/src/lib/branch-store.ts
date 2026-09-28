'use client';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface BranchState {
  /** Selected branch id; null means "all branches" (only for users with multi-branch access). */
  branchId: string | null;
  setBranch: (id: string | null) => void;
}

export const useBranch = create<BranchState>()(
  persist((set) => ({ branchId: null, setBranch: (branchId) => set({ branchId }) }), { name: 'tos-branch' }),
);
