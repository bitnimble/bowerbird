/* The editor's build binds LibRaw and nothing else.

   lensfun stays out because it is a geometry database on disk and the editor's geometry
   comes from the RAW itself - the spline the camera recorded (`lens::read_distortion`),
   or a fit against the embedded JPEG where it recorded none. Measured over 32 Canon
   frames, the fitted path gives up 0.049 luma levels of 255 against lensfun's profile.

   libavif stays out because the display transform is the client's GPU now; nothing on
   this side encodes a file. */
#include <libraw/libraw.h>
