# MarkLogic — complete tool index

Every registered tool, by group. The problem → approach table in the parent SKILL.md
maps problems to the right starting point; this file is the exhaustive list for when you
need to check whether a capability exists at all.

**Answer / recipes** — `ml_answer_query`, `ml_query_recipe`

**Search** — `ml_search`, `ml_search_qbe`, `ml_values_query`, `ml_geospatial_search`,
`ml_parse_query`, `ml_suggest`

**Analytics** — `ml_aggregate_query`, `ml_timeseries_query`, `ml_export_tabular`,
`ml_facets_query`, `ml_optic_query`, `ml_vector_search`, `ml_views_list`

**Documents** *(writes are readonly-gated)* — `ml_document_get`, `ml_document_sample`,
`ml_document_list`, `ml_document_put`, `ml_document_delete`, `ml_document_patch`,
`ml_document_patch_batch`

**Schema / indexes** — `ml_schema_discover`, `ml_schema_get_tde`, `ml_tde_validate`,
`ml_tde_install`, `ml_indexes_list`, `ml_search_surface`, `ml_collections_list`,
`ml_namespaces_list`

**Graph** — `ml_sparql_query`, `ml_graphs_list`, `ml_graph_put`, `ml_graph_delete`

**Flux** *(readonly-gated; unavailable under ML_AUTH_TYPE=oauth)* — `flux_import`,
`flux_export`, `flux_copy`, `flux_reprocess`, `flux_preview`, `flux_help`, `flux_status`

**Admin** — `ml_databases_list`, `ml_database_properties`, `ml_database_statistics`,
`ml_forests_list`, `ml_database_set_forests`, `ml_servers_list`, `ml_server_properties`,
`ml_cluster_status`, `ml_logs_list`, `ml_logs_read`, `ml_reindex_status`

**Performance** — `ml_explain_optic`, `ml_search_query_plan`, `ml_forest_metrics`,
`ml_force_merge` *(eval)*, `ml_profile_query` *(eval)*

**Security** *(read-only)* — `ml_users_list`, `ml_roles_list`, `ml_document_permissions`

**Eval** *(allowEval-gated, and force-disabled under ML_READONLY)* — `ml_eval_xquery`,
`ml_eval_javascript`, `ml_sparql`, `ml_invoke_module`

**REST extensions** *(readonly-gated)* — `ml_extension_list`, `ml_extension_get`,
`ml_extension_call`, `ml_extension_put`, `ml_extension_delete`

**FastTrack search options** *(readonly-gated)* — `ml_search_options_list`,
`ml_search_options_get`, `ml_search_options_put`, `ml_search_options_delete`

**Data Hub Framework** *(eval + readonly + JAR gated)* — `dhf_status`, `dhf_flows_list`,
`dhf_flow_run`, `dhf_flow_run_jar`, `dhf_job_status`

**Semaphore — status & discovery** — `semaphore_status`, `semaphore_studio_status`,
`semaphore_publish_sets`, `semaphore_classes`, `semaphore_cls_languages`,
`semaphore_kmm_models_list`

**Semaphore — classification** — `semaphore_classify`, `semaphore_classify_batch`

**Semaphore — model & taxonomy** — `semaphore_kmm_model_create`,
`semaphore_kmm_model_delete`, `semaphore_kmm_skos_load`, `semaphore_kmm_sparql`,
`semaphore_kmm_sparql_update`, `semaphore_taxonomy_validate`, `semaphore_concept_search`,
`semaphore_concept_get`, `semaphore_concept_labels_update`

**Semaphore — publish & tuning** — `semaphore_publish`,
`semaphore_publish_config_fix_plain_skos`, `semaphore_publish_diagnose`,
`semaphore_kid_template_get`, `semaphore_kid_template_set`

**Semaphore — tasks** — `semaphore_task_list`, `semaphore_task_create`,
`semaphore_task_commit`
