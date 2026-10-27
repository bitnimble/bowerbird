//! Small dense linear algebra for the host solvers.

#![deny(unsafe_code)]

/// Gaussian elimination with partial pivoting over one right-hand side.
///
/// `matrix` is `n` by `n`, row-major. None where a pivot column is numerically empty, which is a
/// singular system and never a result to carry on with.
pub fn solve(matrix: &[f64], rhs: &[f64], n: usize) -> Option<Vec<f64>> {
    let mut a = matrix.to_vec();
    let mut b = rhs.to_vec();
    for col in 0..n {
        let pivot =
            (col..n).max_by(|p, q| a[p * n + col].abs().total_cmp(&a[q * n + col].abs()))?;
        if a[pivot * n + col].abs() < 1e-14 {
            return None;
        }
        if pivot != col {
            for k in 0..n {
                a.swap(col * n + k, pivot * n + k);
            }
            b.swap(col, pivot);
        }
        for row in col + 1..n {
            let factor = a[row * n + col] / a[col * n + col];
            for k in col..n {
                a[row * n + k] -= factor * a[col * n + k];
            }
            b[row] -= factor * b[col];
        }
    }
    for col in (0..n).rev() {
        let mut sum = b[col];
        for k in col + 1..n {
            sum -= a[col * n + k] * b[k];
        }
        b[col] = sum / a[col * n + col];
    }
    Some(b)
}
