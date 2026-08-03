pub use rayon::prelude::*;

pub fn thread_count() -> usize {
    #[cfg(target_arch = "wasm32")]
    {
        wasm_bindgen_rayon::pool_num_threads()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        rayon::current_num_threads()
    }
}

#[cfg(target_arch = "wasm32")]
pub fn with_pool<R: Send>(f: impl FnOnce() -> R + Send) -> R {
    wasm_bindgen_rayon::with_thread_pool(f)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn with_pool<R: Send>(f: impl FnOnce() -> R + Send) -> R {
    f()
}

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

impl<I: rayon::iter::ParallelIterator> ReduceParallel for I {}
