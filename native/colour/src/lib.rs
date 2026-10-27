//! Light and colour as the grade and the fit both read them: the codings, the tone levels, the
//! white balance, the colour spaces, and the camera match's colour model with its lattice.

#![deny(unsafe_code)]

pub mod lattice;
pub mod matched;
pub mod pq_rematch;
pub mod resident;
pub mod sdr_match;
pub mod space;
pub mod tone;
pub mod transfer;
pub mod white_balance;
