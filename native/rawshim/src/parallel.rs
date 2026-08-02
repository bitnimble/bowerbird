// rayon on the server, plain iterators in a browser.
//
// wasm32 has no threads, and the pixel maths behind the camera match - the warp, the
// blurs, the pair collection - is written against rayon's prelude. Rather than fork those
// modules or scatter `#[cfg]` through their hot loops, this supplies the five methods
// they actually use under the same names, so `use crate::parallel::*` swaps one for the
// other and the call sites read identically.
//
// The sequential arm is the same traversal in the same order. That matters: the fit's
// output is pinned, and a reordering that changed a rounding would show up there.

#[cfg(not(target_arch = "wasm32"))]
pub use rayon::prelude::*;

#[cfg(not(target_arch = "wasm32"))]
pub fn thread_count() -> usize {
    rayon::current_num_threads()
}

#[cfg(target_arch = "wasm32")]
pub fn thread_count() -> usize {
    1
}

#[cfg(target_arch = "wasm32")]
pub use sequential::*;

#[cfg(target_arch = "wasm32")]
mod sequential {
    /// Shared slices, by reference.
    pub trait ParallelSlice<T> {
        fn par_iter(&self) -> std::slice::Iter<'_, T>;
        fn par_chunks(&self, size: usize) -> std::slice::Chunks<'_, T>;
    }

    impl<T> ParallelSlice<T> for [T] {
        fn par_iter(&self) -> std::slice::Iter<'_, T> {
            self.iter()
        }

        fn par_chunks(&self, size: usize) -> std::slice::Chunks<'_, T> {
            self.chunks(size)
        }
    }

    impl<T> ParallelSlice<T> for Vec<T> {
        fn par_iter(&self) -> std::slice::Iter<'_, T> {
            self.as_slice().iter()
        }

        fn par_chunks(&self, size: usize) -> std::slice::Chunks<'_, T> {
            self.as_slice().chunks(size)
        }
    }

    /// Mutable slices.
    pub trait ParallelSliceMut<T> {
        fn par_iter_mut(&mut self) -> std::slice::IterMut<'_, T>;
        fn par_chunks_mut(&mut self, size: usize) -> std::slice::ChunksMut<'_, T>;
        fn par_chunks_exact_mut(&mut self, size: usize) -> std::slice::ChunksExactMut<'_, T>;
    }

    impl<T> ParallelSliceMut<T> for [T] {
        fn par_iter_mut(&mut self) -> std::slice::IterMut<'_, T> {
            self.iter_mut()
        }

        fn par_chunks_mut(&mut self, size: usize) -> std::slice::ChunksMut<'_, T> {
            self.chunks_mut(size)
        }

        fn par_chunks_exact_mut(&mut self, size: usize) -> std::slice::ChunksExactMut<'_, T> {
            self.chunks_exact_mut(size)
        }
    }

    impl<T> ParallelSliceMut<T> for Vec<T> {
        fn par_iter_mut(&mut self) -> std::slice::IterMut<'_, T> {
            self.as_mut_slice().iter_mut()
        }

        fn par_chunks_mut(&mut self, size: usize) -> std::slice::ChunksMut<'_, T> {
            self.as_mut_slice().chunks_mut(size)
        }

        fn par_chunks_exact_mut(&mut self, size: usize) -> std::slice::ChunksExactMut<'_, T> {
            self.as_mut_slice().chunks_exact_mut(size)
        }
    }

    /// Anything rayon would consume whole - ranges, vectors, iterator adaptors.
    pub trait IntoParallelIterator {
        type Iter;
        fn into_par_iter(self) -> Self::Iter;
    }

    impl<I: IntoIterator> IntoParallelIterator for I {
        type Iter = I::IntoIter;

        fn into_par_iter(self) -> Self::Iter {
            self.into_iter()
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub trait ReduceParallel: rayon::iter::ParallelIterator + Sized {
    fn reduce_parallel<ID, OP>(self, identity: ID, operation: OP) -> Self::Item
    where
        ID: Fn() -> Self::Item + Sync + Send,
        OP: Fn(Self::Item, Self::Item) -> Self::Item + Sync + Send,
        Self::Item: Send,
    {
        self.reduce(identity, operation)
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl<I: rayon::iter::ParallelIterator> ReduceParallel for I {}

#[cfg(target_arch = "wasm32")]
pub trait ReduceParallel: Iterator + Sized {
    fn reduce_parallel<ID, OP>(self, identity: ID, operation: OP) -> Self::Item
    where
        ID: Fn() -> Self::Item,
        OP: Fn(Self::Item, Self::Item) -> Self::Item,
    {
        self.fold(identity(), operation)
    }
}

#[cfg(target_arch = "wasm32")]
impl<I: Iterator> ReduceParallel for I {}
