const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function uploadToSupabase(buffer, filename, mimetype) {
  const { error } = await supabase.storage
    .from('priconkt-media')
    .upload(filename, buffer, {
      contentType: mimetype,
      upsert: true
    });
  if (error) throw error;
  const { data } = supabase.storage
    .from('priconkt-media')
    .getPublicUrl(filename);
  return data.publicUrl;
}

module.exports = { uploadToSupabase };