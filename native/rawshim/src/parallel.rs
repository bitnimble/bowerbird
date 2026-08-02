pub use rayon::prelude::*;

pub fn thread_count() -> usize {
    rayon::current_num_threads()
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
