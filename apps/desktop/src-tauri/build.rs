fn main() {
    // Migrations are embedded into the binary; rebuild when they change.
    println!("cargo:rerun-if-changed=../../../packages/db/migrations");
    tauri_build::build();
}
