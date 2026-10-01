import { supabaseAdmin } from './supabase'

export {
  CLIENT_LOGOS_BUCKET_NAME,
  RESUME_BUCKET_NAME,
} from "@/lib/constants/storage"
import { RESUME_BUCKET_NAME } from "@/lib/constants/storage"

export const BUCKET_NAME = RESUME_BUCKET_NAME

function extractStoragePath(input: string, bucketName: string) {
  const idx = input.indexOf(`${bucketName}/`)
  if (idx >= 0) return input.slice(idx + bucketName.length + 1)
  return input.replace(/^\/+/, '')
}

/**
 * Check if a file exists in Supabase Storage by name or path
 * @param fileName The file name or path to check
 * @returns Object with exists flag and optional url and path
 */
export async function checkFileExistsInSupabase(fileName: string): Promise<{ exists: boolean; url?: string; path?: string }> {
  try {
    // Resumes are stored content-addressed under a folder ("resumes/<hash>.pdf").
    // The previous version always listed the bucket root and compared against the
    // whole path, so nested files were never matched and this always reported
    // "not found" — even when the exact object existed.
    const cleanPath = fileName.replace(/^\/+/, '')
    const parts = cleanPath.split('/')
    const searchFolder = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
    const searchName = parts[parts.length - 1]

    const { data: files, error } = await supabaseAdmin.storage
      .from(BUCKET_NAME)
      .list(searchFolder, { limit: 1000 })

    if (error) {
      console.error('Error listing files in storage:', error)
      return { exists: false }
    }

    // Directories come back with a null id; only real objects are comparable.
    const existingFile = (files || []).find(
      (file) => file.id !== null && file.name === searchName,
    )

    if (existingFile) {
      console.log(`✅ File already exists in Supabase storage: ${cleanPath}`)

      const { data: { publicUrl } } = supabaseAdmin.storage
        .from(BUCKET_NAME)
        .getPublicUrl(cleanPath)

      return {
        exists: true,
        url: publicUrl,
        path: cleanPath,
      }
    }

    return { exists: false }
  } catch (error) {
    // If we can't check, assume it doesn't exist and proceed with upload
    return { exists: false }
  }
}

/**
 * Upload a file to Supabase Storage
 * @param file The file or blob to upload
 * @param fileName The filename to use in storage
 * @returns Object with url and path of the uploaded file
 */
export async function uploadFileToSupabase(
  file: File | Blob,
  fileName: string,
  options?: { bucketName?: string }
): Promise<{ url: string; path: string }> {
  try {
    const bucketName = options?.bucketName || BUCKET_NAME
    const contentType = (file as any)?.type || undefined
    // Upload the file using admin client to bypass RLS policies
    const { data, error } = await supabaseAdmin.storage
      .from(bucketName)
      .upload(fileName, file, {
        cacheControl: '3600',
        upsert: true,
        ...(contentType ? { contentType } : {}),
      })
    
    if (error) {
      console.error('❌ Failed to upload to Supabase Storage:', error)
      throw error
    }
    
    // Get the public URL
    const { data: { publicUrl } } = supabaseAdmin.storage
      .from(bucketName)
      .getPublicUrl(data.path)
    
    return { url: publicUrl, path: data.path }
  } catch (error) {
    throw error
  }
}

/**
 * Delete a file from Supabase Storage
 * @param url The URL or path of the file to delete
 * @returns Boolean indicating success
 */
export async function deleteFileFromSupabase(urlOrPath: string, options?: { bucketName?: string }): Promise<boolean> {
  try {
    const bucketName = options?.bucketName || BUCKET_NAME
    const path = extractStoragePath(urlOrPath, bucketName)
    
    // Delete the file using admin client to bypass RLS
    const { error } = await supabaseAdmin.storage
      .from(bucketName)
      .remove([path])
    
    if (error) {
      console.error('❌ Failed to delete from Supabase Storage:', error)
      throw error
    }
    
    return true
  } catch (error) {
    return false
  }
}
