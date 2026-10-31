/** 本地头像预处理：限制文件大小，按中心裁成方图，压缩后再上传，避免传输原始大图。 */
export async function prepareAvatar(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片')
  if (file.size > 5 * 1024 * 1024) throw new Error('原图不能超过 5MB')
  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('读取图片失败，请重新选择'))
    reader.readAsDataURL(file)
  })
  const image = await new Promise((resolve, reject) => {
    const value = new Image()
    value.onload = () => resolve(value)
    value.onerror = () => reject(new Error('图片无法显示，请选择完整的图片文件'))
    value.src = source
  })
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 16 * 1024 * 1024) throw new Error('图片尺寸过大，请选择不超过 1600 万像素的图片')
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 512
  const side = Math.min(image.naturalWidth, image.naturalHeight)
  canvas.getContext('2d').drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 512, 512)
  const data = canvas.toDataURL('image/webp', 0.85)
  if (data.length > 700000) throw new Error('图片压缩后仍然过大，请选择更简单的图片')
  return data
}
