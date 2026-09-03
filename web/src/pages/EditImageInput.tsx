interface EditImageInputProps {
  files: File[];
  previews: string[];
  onChange: (files: File[]) => void;
}

export default function EditImageInput({ files, previews, onChange }: EditImageInputProps) {
  return (
    <>
      <label htmlFor="pg-edit-image">原图（可多选，PNG/JPG/WebP）</label>
      <input
        id="pg-edit-image"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        onChange={(e) => onChange(Array.from(e.target.files ?? []))}
        required={files.length === 0}
      />
      {previews.length > 0 && (
        <div className="edit-previews">
          {files.map((file, index) => (
            <figure key={`${file.name}-${index}`} className="edit-preview tip" data-tip={file.name}>
              <img src={previews[index]} alt={`原图 ${index + 1}：${file.name}`} />
              <figcaption className="muted">{file.name}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </>
  );
}
